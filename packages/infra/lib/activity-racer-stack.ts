import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
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

    // 2. Phase 1 health-check Lambda (ARM64, Node.js 22, explicit LogGroup for clean teardown)
    const healthLogGroup = new logs.LogGroup(this, 'HealthFunctionLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const healthFn = new nodejs.NodejsFunction(this, 'HealthFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../backend/src/handlers/health.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: healthLogGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
    });

    // 3. API Gateway HTTP API (cheaper and simpler than REST API)
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
        // Phase 1 walking skeleton allows all origins; we can restrict to CloudFront + localhost in Phase 2/3.
        allowOrigins: ['*'],
      },
    });

    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HealthIntegration', healthFn),
    });

    // 4. Static SPA hosting: Private S3 bucket + CloudFront OAC (no Lambda@Edge)
    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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
      // SPA client-side routing fallback for React Router without using Lambda@Edge
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

    // Deploy Vite build + runtime config.json to S3 and invalidate entrypoints
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../frontend/dist')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: httpApi.apiEndpoint,
          region: this.region,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/index.html', '/config.json'],
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the Activity Racer frontend',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API Gateway base URL',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB single-table name',
    });
  }
}
