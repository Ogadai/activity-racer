import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export class ActivityRacerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Feature flags via CDK context (`-c enableCloudFront=true`, `-c enableGoogleAuth=true`, `-c enableAiCommentary=true`)
    const enableCloudFront = this.node.tryGetContext('enableCloudFront') === 'true';
    const enableGoogleAuth = this.node.tryGetContext('enableGoogleAuth') === 'true';
    const enableAiCommentary = this.node.tryGetContext('enableAiCommentary') !== 'false';
    const geminiApiKeyParamName = '/activity-racer/gemini-api-key';
    const geminiModelParamName = '/activity-racer/gemini-model';
    const explicitDomainPrefix = this.node.tryGetContext('cognitoDomainPrefix') as
      | string
      | undefined;
    const cognitoDomainPrefix = explicitDomainPrefix?.trim() || `activity-racer-${cdk.Aws.ACCOUNT_ID}`;

    const callbackPath = '/auth/callback';
    const logoutPath = '/login';

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

    // 2. API Gateway HTTP API + Private S3 SPA Bucket (created before Cognito Client so callback URLs are known)
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

    const apiBaseUrl = `${httpApi.apiEndpoint}/api`;

    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    let distribution: cloudfront.Distribution | undefined;
    let frontendUrl: string;

    if (enableCloudFront) {
      // Production-preferred path: CloudFront OAC in front of private S3 (no Lambda@Edge)
      const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

      distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
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

      frontendUrl = `https://${distribution.distributionDomainName}`;
    } else {
      frontendUrl = httpApi.apiEndpoint;
    }

    // 3. Amazon Cognito User Pool, Managed Login v2 Domain & OAuth 2.0 PKCE Public SPA Client
    // Note: selfSignUpEnabled is false to prevent public email/password registration;
    // federated Google sign-ins still auto-provision users on first login.
    // Standard attributes remain unchanged from Phase 2 to avoid User Pool replacement.
    const userPool = new cognito.UserPool(this, 'ActivityRacerUserPool', {
      userPoolName: 'activity-racer-users',
      selfSignUpEnabled: false,
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

    const userPoolDomain = userPool.addDomain('ActivityRacerDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const cognitoDomainUrl = userPoolDomain.baseUrl();

    const callbackUrls = [
      `${frontendUrl}${callbackPath}`,
      `http://localhost:5173${callbackPath}`,
    ];
    const logoutUrls = [`${frontendUrl}${logoutPath}`, `http://localhost:5173${logoutPath}`];

    const userPoolClient = userPool.addClient('ActivityRacerSpaClient', {
      userPoolClientName: 'activity-racer-spa',
      generateSecret: false, // Required for public browser SPA clients (PKCE)
      authFlows: {
        userSrp: false,
        adminUserPassword: true, // IAM-only flow retained for CLI smoke testing
      },
      supportedIdentityProviders: enableGoogleAuth
        ? [cognito.UserPoolClientIdentityProvider.GOOGLE]
        : [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Managed login v2 requires an explicit branding style per app client when created via IaC/API
    const managedLoginBranding = new cognito.CfnManagedLoginBranding(
      this,
      'ActivityRacerSpaBranding',
      {
        userPoolId: userPool.userPoolId,
        clientId: userPoolClient.userPoolClientId,
        useCognitoProvidedValues: true,
      },
    );
    managedLoginBranding.node.addDependency(userPoolDomain);

    // Helper to create consistent ARM64 Node.js 22 Lambdas with explicit 7-day LogGroups
    const createApiLambda = (
      idPrefix: string,
      handlerFile: string,
      environment?: Record<string, string>,
      timeout: cdk.Duration = cdk.Duration.seconds(10),
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
        timeout,
        logGroup,
        environment,
        bundling: {
          minify: true,
          sourceMap: true,
          forceDockerBundling: false,
        },
      });
    };

    // 4. API Lambdas with least-privilege DynamoDB grants
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

    const commentaryFn = enableAiCommentary
      ? createApiLambda(
          'Commentary',
          'commentary.ts',
          {
            TABLE_NAME: table.tableName,
            GEMINI_API_KEY_PARAM: geminiApiKeyParamName,
            GEMINI_MODEL_PARAM: geminiModelParamName,
            GEMINI_MODEL: 'gemini-3.1-flash-lite',
          },
          cdk.Duration.seconds(25),
        )
      : undefined;

    if (commentaryFn) {
      table.grantReadWriteData(commentaryFn);
      // Least-privilege access to Standard-tier SSM parameters ($0 Always Free)
      commentaryFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${cdk.Aws.ACCOUNT_ID}:parameter${geminiApiKeyParamName}`,
            `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${cdk.Aws.ACCOUNT_ID}:parameter${geminiModelParamName}`,
          ],
        }),
      );
    }

    // 5. Built-in Cognito JWT Authorizer & API Routes
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

    if (commentaryFn) {
      httpApi.addRoutes({
        path: '/api/groups/{groupId}/commentary',
        methods: [apigwv2.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration('CommentaryIntegration', commentaryFn),
        authorizer: jwtAuthorizer,
      });
    }

    // 6. Deploy Frontend SPA + Runtime config.json
    const deploySources: s3deploy.ISource[] = [
      s3deploy.Source.asset(path.join(__dirname, '../../frontend/dist')),
      s3deploy.Source.jsonData('config.json', {
        apiUrl: apiBaseUrl,
        region: this.region,
        userPoolId: userPool.userPoolId,
        userPoolClientId: userPoolClient.userPoolClientId,
        cognitoDomain: cognitoDomainUrl,
        googleAuthEnabled: enableGoogleAuth,
        callbackPath,
        logoutPath,
        hostingMode: enableCloudFront ? 'cloudfront' : 'apigw-lambda-s3',
        aiCommentaryEnabled: enableAiCommentary,
      }),
    ];

    if (distribution) {
      new s3deploy.BucketDeployment(this, 'DeployFrontend', {
        sources: deploySources,
        destinationBucket: siteBucket,
        distribution,
        distributionPaths: ['/index.html', '/config.json'],
      });
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

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: cognitoDomainUrl,
      description: 'Cognito Managed Login domain base URL',
    });

    new cdk.CfnOutput(this, 'GoogleJavaScriptOrigin', {
      value: cognitoDomainUrl,
      description: 'Authorized JavaScript origin to configure in Google Cloud Console',
    });

    new cdk.CfnOutput(this, 'GoogleRedirectUri', {
      value: `${cognitoDomainUrl}/oauth2/idpresponse`,
      description: 'Authorized redirect URI to configure in Google Cloud Console',
    });

    new cdk.CfnOutput(this, 'GoogleAuthEnabled', {
      value: enableGoogleAuth ? 'true' : 'false',
      description: 'Whether the Google IdP is attached to the Cognito SPA client',
    });

    if (enableAiCommentary) {
      new cdk.CfnOutput(this, 'GeminiApiKeyParamPath', {
        value: geminiApiKeyParamName,
        description: 'SSM Parameter Store (SecureString, Standard tier) path for the Gemini API key',
      });
      new cdk.CfnOutput(this, 'GeminiModelParamPath', {
        value: geminiModelParamName,
        description: 'SSM Parameter Store (String, Standard tier) path for the Gemini model ID',
      });
    }
  }
}
