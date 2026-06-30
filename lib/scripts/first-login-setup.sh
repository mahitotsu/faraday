export PATH="$HOME/.local/bin:$PATH"
if [ ! -f "$HOME/.setup_done" ]; then
  _log="$HOME/.setup.log"
  echo "Installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | bash >> "$_log" 2>&1

  # EC2 メタデータ (IMDSv2) からリージョンを取得
  _token=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null)
  _region=$(curl -s -H "X-aws-ec2-metadata-token: $_token" \
    "http://169.254.169.254/latest/meta-data/placement/region" 2>/dev/null)
  _region="${_region:-ap-northeast-1}"

  # AgentCore Gateway URL (末尾は /mcp 済み) を SSM から取得 (mcp-proxy-for-aws の引数に使用)
  _mcp_endpoint=$(aws ssm get-parameter --region "$_region" \
    --name /faraday/agentcore-gateway-url \
    --query Parameter.Value --output text 2>/dev/null || echo "")

  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/settings.json" << SETTINGS
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "$_region",
    "ANTHROPIC_MODEL": "jp.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_RESOURCE_ATTRIBUTES": "service.name=claude-code"
  }
}
SETTINGS
  # インストール確認: 失敗していれば setup_done を作らず次回再試行できるようにする
  if command -v claude > /dev/null 2>&1; then
    # settings.json の mcpServers キーは Claude Code に読まれないため、claude mcp add で正式に登録する
    claude mcp add faraday-memos -s user -- mcp-proxy-for-aws "$_mcp_endpoint" --region "$_region"
    touch "$HOME/.setup_done"
    echo "Setup complete."
  else
    echo "ERROR: Claude Code installation failed. Check $HOME/.setup.log" >&2
  fi
fi
