import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export class ActivityRacerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Toggle CloudFront via `-c enableCloudFront=true` once AWS Support unlocks CloudFront
    const enableCloudFront = this.node.tryGetContext('enableCloudFront') === 'true';

    // 1. Single-table DynamoDB store (on-demand, zero idle cost, clean dev teardown)
    const table = new dynamodb.Table(this, 'ActivityRacerTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 2. Amazon Cognito User Pool + Public SPA Client
    // Non-production dev exception: 8+ char password policy & MFA OFF for low-friction testing.
    // Structured with mutable email & EMAIL_ONLY recovery for future Google federation ($0 SMS).
    const userPool = new cognito.UserPool(this, 'ActivityRacerUserPool', {
      userPoolName: 'activity-racer-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('ActivityRacerSpaClient', {
      userPoolClientName: 'activity-racer-spa',
      generateSecret: false, // Required for public browser SPA clients
      authFlows: {
        userSrp: true,
        adminUserPassword: true, // IAM-only flow for CLI smoke testing
      },
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Helper to create consistent ARM64 Node.js 22 Lambdas with explicit 7-day LogGroups
    const createApiLambda = (
      idPrefix: string,
      handlerFile: string,
      environment?: Record<string, string>,
    ): nodejs.NodejsFunction => {
      const logGroup = new logs.LogGroup(this, `${idPrefix}FunctionLogs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      return new nodejs.NodejsFunction(this, `${idPrefix}Function`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '../../backend/src/handlers', handlerFile),
        handler: 'handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup,
        environment,
        bundling: {
          minify: true,
          sourceMap: true,
          forceDockerBundling: false,
        },
      });
    };

    // 3. API Lambdas with least-privilege DynamoDB grants
    const healthFn = createApiLambda('Health', 'health.ts');

    const ingestStatsFn = createApiLambda('IngestStats', 'ingestStats.ts', {
      TABLE_NAME: table.tableName,
    });
    table.grantReadWriteData(ingestStatsFn);

    const playerFn = createApiLambda('Player', 'player.ts', {
      TABLE_NAME: table.tableName,
    });
    table.grantReadWriteData(playerFn);

    const groupsFn = createApiLambda('Groups', 'groups.ts', {
      TABLE_NAME: table.tableName,
    });
    table.grantReadWriteData(groupsFn);

    const raceFn = createApiLambda('Race', 'race.ts', {
      TABLE_NAME: table.tableName,
    });
    table.grantReadData(raceFn);

    // 4. API Gateway HTTP API + Built-in Cognito JWT Authorizer
    const httpApi = new apigwv2.HttpApi(this, 'ActivityRacerApi', {
      apiName: 'activity-racer-api',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    const jwtAuthorizer = new authorizers.HttpUserPoolAuthorizer(
      'CognitoJwtAuthorizer',
      userPool,
      {
        userPoolClients: [userPoolClient],
      },
    );

    // Public routes
    httpApi.addRoutes({
      path: '/api/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthIntegration', healthFn),
    });

    // Home Assistant webhook (authenticated via per-player x-api-key header + playerSlug)
    httpApi.addRoutes({
      path: '/api/stats',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('IngestStatsIntegration', ingestStatsFn),
    });

    // Authenticated player & group routes (Cognito JWT Authorizer)
    const playerIntegration = new integrations.HttpLambdaIntegration('PlayerIntegration', playerFn);
    httpApi.addRoutes({
      path: '/api/me',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: playerIntegration,
      authorizer: jwtAuthorizer,
    });

    const groupsIntegration = new integrations.HttpLambdaIntegration('GroupsIntegration', groupsFn);
    httpApi.addRoutes({
      path: '/api/groups',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: groupsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/api/groups/join',
      methods: [apigwv2.HttpMethod.POST],
      integration: groupsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/api/groups/{groupId}/race',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('RaceIntegration', raceFn),
      authorizer: jwtAuthorizer,
    });

    const apiBaseUrl = `${httpApi.apiEndpoint}/api`;

    // 5. Static SPA hosting: always store assets in a private S3 bucket
    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const deploySources: s3deploy.ISource[] = [
      s3deploy.Source.asset(path.join(__dirname, '../../frontend/dist')),
      s3deploy.Source.jsonData('config.json', {
        apiUrl: apiBaseUrl,
        region: this.region,
        userPoolId: userPool.userPoolId,
        userPoolClientId: userPoolClient.userPoolClientId,
        hostingMode: enableCloudFront ? 'cloudfront' : 'apigw-lambda-s3',
      }),
    ];

    let frontendUrl: string;

    if (enableCloudFront) {
      // Production-preferred path: CloudFront OAC in front of private S3 (no Lambda@Edge)
      const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

      const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
        comment: 'Activity Racer SPA distribution',
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        additionalBehaviors: {
          '/config.json': {
            origin: s3Origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          },
        },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.seconds(0),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.seconds(0),
          },
        ],
      });

      new s3deploy.BucketDeployment(this, 'DeployFrontend', {
        sources: deploySources,
        destinationBucket: siteBucket,
        distribution,
        distributionPaths: ['/index.html', '/config.json'],
      });

      frontendUrl = `https://${distribution.distributionDomainName}`;
    } else {
      // Temporary Option B3 stand-in while CloudFront verification is pending:
      // Serve private S3 SPA assets over HTTPS through HTTP API Gateway + ARM64 Lambda.
      const spaFn = createApiLambda('SpaHosting', 'spa.ts', {
        SITE_BUCKET_NAME: siteBucket.bucketName,
      });

      siteBucket.grantRead(spaFn);

      const spaIntegration = new integrations.HttpLambdaIntegration('SpaIntegration', spaFn);

      httpApi.addRoutes({
        path: '/',
        methods: [apigwv2.HttpMethod.GET],
        integration: spaIntegration,
      });

      httpApi.addRoutes({
        path: '/{proxy+}',
        methods: [apigwv2.HttpMethod.GET],
        integration: spaIntegration,
      });

      new s3deploy.BucketDeployment(this, 'DeployFrontend', {
        sources: deploySources,
        destinationBucket: siteBucket,
      });

      frontendUrl = httpApi.apiEndpoint;
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: frontendUrl,
      description: enableCloudFront
        ? 'CloudFront URL for the Activity Racer frontend'
        : 'HTTPS API Gateway URL serving the Activity Racer SPA (Option B3)',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: apiBaseUrl,
      description: 'HTTP API Gateway base URL for /api/* routes',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB single-table name',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito Public SPA User Pool Client ID',
    });
  }
}
