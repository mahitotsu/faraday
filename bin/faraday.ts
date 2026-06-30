#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FaradayStack } from '../lib/faraday-stack';

const app = new cdk.App();
new FaradayStack(app, 'FaradayStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
