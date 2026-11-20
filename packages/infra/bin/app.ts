import * as cdk from 'aws-cdk-lib';
import { ActivityRacerStack } from '../lib/activity-racer-stack';

const SELECTED_REGION = 'eu-north-1';

const explicitRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
if (explicitRegion && explicitRegion !== SELECTED_REGION) {
  throw new Error(
    `Refusing to deploy outside selected Region '${SELECTED_REGION}' (got '${explicitRegion}').`,
  );
}

const app = new cdk.App();

new ActivityRacerStack(app, 'ActivityRacerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: SELECTED_REGION,
  },
  description: 'Activity Racer serverless fitness tracking app (dev stack)',
});
