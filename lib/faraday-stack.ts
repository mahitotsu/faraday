import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export class FaradayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'Security group for EC2 with SSM access',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Bedrock Invoke: jp. 推論プロファイルのみ許可 (ap-northeast-1 から呼び出し)
    // クロスリージョン推論では内部で他リージョンの foundation model が使われるため両方許可
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInferenceProfile',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/jp.anthropic.claude*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockFoundationModel',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude*',
      ],
    }));
    // X-Ray トレース送信 (ADOT awsxray exporter が使用)
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayTraces',
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
      ],
      resources: ['*'],
    }));

    // ap-northeast-1 以外への API 呼び出しを拒否
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DenyBedrockOutsideRegion',
      effect: iam.Effect.DENY,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/jp.anthropic.claude*`],
      conditions: {
        StringNotEquals: { 'aws:RequestedRegion': this.region },
      },
    }));
    // AgentCore Gateway 経由で MCP ツールを呼び出す権限
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreGatewayInvoke',
      actions: ['bedrock-agentcore:InvokeGateway'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
    }));

    // CloudWatch Log Groups
    const sessionLogGroup = new logs.LogGroup(this, 'SessionLogGroup', {
      logGroupName: '/aws/ssm/claude-sessions',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.LogGroup(this, 'OtelMetricsLogGroup', {
      logGroupName: '/aws/claude-code/metrics',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.LogGroup(this, 'OtelEventsLogGroup', {
      logGroupName: '/aws/claude-code/events',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudTrail (S3 + Bedrock データイベント)
    const trailBucket = new s3.Bucket(this, 'TrailBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });
    new cloudtrail.Trail(this, 'AuditTrail', {
      bucket: trailBucket,
      includeGlobalServiceEvents: false,
      isMultiRegionTrail: false,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
    });

    // ── メモアプリ: DynamoDB ────────────────────────────────────────────
    const memosTable = new dynamodb.Table(this, 'MemosTable', {
      tableName: 'FaradayMemos',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    // ── メモアプリ: Lambda (MCP ツール実行) ────────────────────────────
    // ADOT Lambda Layer: boto3/botocore (DynamoDB呼び出し) を自動計装してX-Rayサブセグメントとして記録する
    // (aws-xray-sdkでの手動patch_allは不要。コード変更なしでOK)
    // 旧世代の aws-otel-python-amd64-ver-* レイヤーは deprecated (組み込みコレクター方式)。
    // 新世代の AWSOpenTelemetryDistroPython はLambdaのhandler自体も自動計装し、
    // ネイティブのX-Ray Active Tracingセグメント(_X_AMZN_TRACE_ID)と正しく合流する設計のためこちらを使用する。
    // https://aws-otel.github.io/docs/getting-started/lambda
    const adotLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'AdotPythonLayer',
      `arn:aws:lambda:${this.region}:615299751070:layer:AWSOpenTelemetryDistroPython:26`,
    );
    const memoLambda = new lambda.Function(this, 'MemoLambda', {
      functionName: 'FaradayMemoMCP',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'memo-mcp-server')),
      environment: {
        DYNAMODB_TABLE: memosTable.tableName,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
        // Gateway側のX-Rayトレースコンテキストに子セグメントとして合流させる
        OTEL_PROPAGATORS: 'xray',
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      layers: [adotLayer],
    });
    memosTable.grantReadWriteData(memoLambda);

    // ── AgentCore Gateway IAM ロール ────────────────────────────────────
    const gatewayRole = new iam.Role(this, 'AgentCoreGatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [memoLambda.functionArn],
    }));

    // ── AgentCore Gateway (MCP, AWS_IAM, SEMANTIC 検索) ─────────────────
    const gateway = new agentcore.CfnGateway(this, 'AgentCoreGateway', {
      name: 'FaradayGateway',
      description: 'MCP Gateway for Faraday — memo management tools with semantic search',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
      protocolConfiguration: {
        mcp: {
          searchType: 'SEMANTIC',
          supportedVersions: ['2025-03-26'],
          instructions: [
            'Faraday memo management.',
            'create_memo: 新しいメモを作成',
            'list_memos: メモ一覧 (limit, filter_tag)',
            'get_memo: ID でメモを取得',
            'update_memo: メモを更新',
            'delete_memo: メモを削除',
            'search_memos: キーワードでメモを全文検索',
          ].join(' '),
        },
      },
    });

    // ── AgentCore GatewayTarget (Lambda 直接呼び出し) ───────────────────
    type ToolDef = agentcore.CfnGatewayTarget.ToolDefinitionProperty;
    const strProp = (description: string): agentcore.CfnGatewayTarget.SchemaDefinitionProperty =>
      ({ type: 'string', description });
    const toolDefs: ToolDef[] = [
      {
        name: 'create_memo',
        description: 'Create a new memo. Returns the created memo id.',
        inputSchema: {
          type: 'object',
          properties: {
            title:   strProp('Title of the memo'),
            content: strProp('Body content of the memo'),
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional list of tags' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'list_memos',
        description: 'List memos sorted by creation date (newest first). Optionally filter by tag.',
        inputSchema: {
          type: 'object',
          properties: {
            limit:      { type: 'integer', description: 'Max memos to return (default 20)' },
            filter_tag: strProp('Return only memos that have this tag'),
          },
        },
      },
      {
        name: 'get_memo',
        description: 'Get a single memo by its id.',
        inputSchema: {
          type: 'object',
          properties: { memo_id: strProp('The memo id to retrieve') },
          required: ['memo_id'],
        },
      },
      {
        name: 'update_memo',
        description: 'Update title, content, or tags of an existing memo. Only provided fields are changed.',
        inputSchema: {
          type: 'object',
          properties: {
            memo_id: strProp('The memo id to update'),
            title:   strProp('New title'),
            content: strProp('New content'),
            tags: { type: 'array', items: { type: 'string' }, description: 'New tag list' },
          },
          required: ['memo_id'],
        },
      },
      {
        name: 'delete_memo',
        description: 'Permanently delete a memo by its id.',
        inputSchema: {
          type: 'object',
          properties: { memo_id: strProp('The memo id to delete') },
          required: ['memo_id'],
        },
      },
      {
        name: 'search_memos',
        description: 'Full-text search across memo titles and content. Returns matching memos.',
        inputSchema: {
          type: 'object',
          properties: { query: strProp('Search keyword or phrase') },
          required: ['query'],
        },
      },
    ];

    const gatewayTarget = new agentcore.CfnGatewayTarget(this, 'MemoMCPTarget', {
      name: 'FaradayMemoMCP',
      description: 'Memo management tools backed by DynamoDB',
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: memoLambda.functionArn,
            toolSchema: { inlinePayload: toolDefs },
          },
        },
      },
      // Lambda ターゲットには credentialProviderConfigurations が必須
      // GATEWAY_IAM_ROLE: Gateway の roleArn でそのまま Lambda を呼び出す
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    });
    gatewayTarget.addDependency(gateway);

    // ── Observability: CloudWatch Transaction Search (account-level) ───
    // 注意: "aws/spans" ロググループは CloudFormation/CLI からは作成できない
    // ("Log groups starting with AWS/ are reserved for AWS" で拒否される)。
    // X-Rayサービス自身が初回スパン受信時に内部権限で作成する想定のため、CDKでは管理しない。
    // もし存在しない場合は CloudWatch コンソール → Application Signals → Transaction Search で
    // 「Enable Transaction Search」→「ingest spans as structured logs」チェックを入れ直す必要がある。
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search-getting-started.html
    const appSignalsDataLogGroup = new logs.LogGroup(this, 'ApplicationSignalsDataLogGroup', {
      logGroupName: '/aws/application-signals/data',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // 既存の resource policy (XRayToLogsIngestion_DO-NOT-EDIT_...) が xray.amazonaws.com への
    // PutLogEvents 権限を既に account-wide に付与済みのため、ここでは追加しない

    // Transaction Search (AWS::XRay::TransactionSearchConfig) はaccount-levelのシングルトンで
    // 既にCDK管理外で有効化済み (indexingPercentage=1%, Destination=CloudWatchLogs) のためここでは定義しない。
    // 変更したい場合は `aws xray update-indexing-rule --name Default --rule '{"Probabilistic":{"DesiredSamplingPercentage":N}}'`

    // ── Observability: Gateway のログ/トレース配信 ─────────────────────
    // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html#observability-configure-cloudwatch-sdk
    const gatewayLogGroup = new logs.LogGroup(this, 'GatewayApplicationLogsGroup', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/${gateway.attrGatewayIdentifier}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const gatewayLogsSource = new logs.CfnDeliverySource(this, 'GatewayLogsSource', {
      name: 'faradaygateway-logs-source',
      logType: 'APPLICATION_LOGS',
      resourceArn: gateway.attrGatewayArn,
    });
    const gatewayTracesSource = new logs.CfnDeliverySource(this, 'GatewayTracesSource', {
      name: 'faradaygateway-traces-source',
      logType: 'TRACES',
      resourceArn: gateway.attrGatewayArn,
    });

    const gatewayLogsDestination = new logs.CfnDeliveryDestination(this, 'GatewayLogsDestination', {
      name: 'faradaygateway-logs-destination',
      deliveryDestinationType: 'CWL',
      destinationResourceArn: gatewayLogGroup.logGroupArn,
    });
    const gatewayTracesDestination = new logs.CfnDeliveryDestination(this, 'GatewayTracesDestination', {
      name: 'faradaygateway-traces-destination',
      deliveryDestinationType: 'XRAY',
    });

    const gatewayLogsDelivery = new logs.CfnDelivery(this, 'GatewayLogsDelivery', {
      deliverySourceName: gatewayLogsSource.name,
      deliveryDestinationArn: gatewayLogsDestination.attrArn,
    });
    gatewayLogsDelivery.addDependency(gatewayLogsSource);
    gatewayLogsDelivery.addDependency(gatewayLogsDestination);

    const gatewayTracesDelivery = new logs.CfnDelivery(this, 'GatewayTracesDelivery', {
      deliverySourceName: gatewayTracesSource.name,
      deliveryDestinationArn: gatewayTracesDestination.attrArn,
    });
    gatewayTracesDelivery.addDependency(gatewayTracesSource);
    gatewayTracesDelivery.addDependency(gatewayTracesDestination);

    // Gateway URL を SSM に保存 (first-login-setup.sh で mcp-proxy-for-aws の引数として参照)
    const gatewayUrlParam = new ssm.StringParameter(this, 'AgentCoreGatewayUrl', {
      parameterName: '/faraday/agentcore-gateway-url',
      stringValue: gateway.attrGatewayUrl,
      description: 'AgentCore Gateway MCP endpoint URL (already ends with /mcp)',
    });
    gatewayUrlParam.grantRead(role);

    // Bedrock モデル呼び出しログ (アカウントレベル設定)
    // リクエスト/レスポンス本文を含むフルログを CloudWatch に記録
    const bedrockInvocationLogGroup = new logs.LogGroup(this, 'BedrockInvocationLogGroup', {
      logGroupName: '/aws/bedrock/model-invocations',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*` },
        },
      }),
    });
    bedrockLoggingRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [bedrockInvocationLogGroup.logGroupArn, `${bedrockInvocationLogGroup.logGroupArn}:*`],
    }));

    const bedrockLoggingConfig = new cr.AwsCustomResource(this, 'BedrockLoggingConfig', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: bedrockInvocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('BedrockLoggingConfig'),
        region: this.region,
      },
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: bedrockInvocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('BedrockLoggingConfig'),
        region: this.region,
      },
      onDelete: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            textDataDeliveryEnabled: false,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('BedrockLoggingConfig'),
        region: this.region,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock:PutModelInvocationLoggingConfiguration'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });
    bedrockLoggingConfig.node.addDependency(bedrockInvocationLogGroup);
    bedrockLoggingConfig.node.addDependency(bedrockLoggingRole);

    // ADOT config を SSM Parameter Store に保存 (SSM Distributor から参照)
    const adotConfigParam = new ssm.StringParameter(this, 'AdotConfig', {
      parameterName: '/faraday/adot-config',
      stringValue: fs.readFileSync(path.join(__dirname, 'scripts/adot-config.yaml'), 'utf8'),
      description: 'ADOT Collector configuration for Claude Code telemetry',
    });
    // SSM Distributor がインスタンス上で aws ssm get-parameter を実行するため付与
    adotConfigParam.grantRead(role);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      // AL2023 起動時の自動パッケージ処理が RPM ロックを保持している場合があるため待機
      'until flock -n /var/lib/rpm/.rpm.lock true 2>/dev/null; do echo "Waiting for rpm lock..."; sleep 3; done',
      'dnf update -y',
      'dnf install -y bubblewrap',

      // mcp-proxy-for-aws は Python >=3.10 必須だが AL2023 の標準 python3 は 3.9 のため python3.12 を別途導入
      'dnf install -y python3.12 python3.12-pip',

      // mcp-proxy-for-aws: Claude Code から AgentCore Gateway を SigV4 認証で呼び出すプロキシ
      // first-login-setup.sh が claude mcp add の command として参照する (/usr/local/bin に入りPATH解決される)
      'python3.12 -m pip install mcp-proxy-for-aws -q',

      // 初回ログイン時にログインユーザーとしてツールをインストール・設定
      `cat > /etc/profile.d/first-login-setup.sh << 'SCRIPT'\n${
        fs.readFileSync(path.join(__dirname, 'scripts/first-login-setup.sh'), 'utf8')
      }SCRIPT`,
      'chmod 644 /etc/profile.d/first-login-setup.sh',
    );

    const instance = new ec2.Instance(this, 'InstanceV17', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role,
      ssmSessionPermissions: true,
      userData,
    });

    // ADOT インストール: SSM Distributor 経由 (Package は AWS-ConfigureAWSPackage で扱う)
    const adotInstall = new ssm.CfnAssociation(this, 'AdotInstall', {
      name: 'AWS-ConfigureAWSPackage',
      associationName: 'FaradayAdotInstall',
      targets: [{ key: 'InstanceIds', values: [instance.instanceId] }],
      parameters: {
        action: ['Install'],
        name: ['AWSDistroOTel-Collector'],
      },
    });
    adotInstall.addDependency(instance.node.defaultChild as ec2.CfnInstance);

    // ADOT 設定: インストール完了後にSSMパラメータから config を書き込み起動
    // インストール完了を最大5分待機してから設定する
    const adotConfigure = new ssm.CfnAssociation(this, 'AdotConfigure', {
      name: 'AWS-RunShellScript',
      associationName: 'FaradayAdotConfigure',
      targets: [{ key: 'InstanceIds', values: [instance.instanceId] }],
      parameters: {
        commands: [
          'set -e',
          'for i in $(seq 1 30); do [ -x /opt/aws/aws-otel-collector/bin/aws-otel-collector-ctl ] && break; echo "Waiting for ADOT ($i/30)..."; sleep 10; done',
          `aws ssm get-parameter --region ${this.region} --name ${adotConfigParam.parameterName} --query Parameter.Value --output text > /opt/aws/aws-otel-collector/etc/aws-otel-collector.yaml`,
          '/opt/aws/aws-otel-collector/bin/aws-otel-collector-ctl -a stop || true',
          '/opt/aws/aws-otel-collector/bin/aws-otel-collector-ctl -c /opt/aws/aws-otel-collector/etc/aws-otel-collector.yaml -a start',
        ],
      },
    });
    adotConfigure.addDependency(adotInstall);

    const sessionDocument = new ssm.CfnDocument(this, 'ClaudeSessionDocument', {
      documentType: 'Session',
      content: {
        schemaVersion: '1.0',
        description: 'SSM session that forces Claude Code on connect',
        sessionType: 'Standard_Stream',
        inputs: {
          cloudWatchLogGroupName: sessionLogGroup.logGroupName,
          cloudWatchStreamingEnabled: true,
          shellProfile: {
            linux: 'cloud-init status --wait 2>/dev/null; . /etc/profile && exec claude',
          },
        },
      },
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID (use: aws ssm start-session --target <id>)',
    });

    new cdk.CfnOutput(this, 'SessionDocumentName', {
      value: sessionDocument.ref,
      description: 'SSM Session Document that forces Claude Code on connect',
    });

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gateway.attrGatewayUrl,
      description: 'AgentCore Gateway MCP endpoint URL (already ends with /mcp)',
    });

    new cdk.CfnOutput(this, 'MemosTableName', {
      value: memosTable.tableName,
      description: 'DynamoDB table for memos',
    });
  }
}
