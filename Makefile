STACK_NAME := FaradayStack
REGION     := ap-northeast-1

# CloudFormation OutputsからインスタンスIDを取得
INSTANCE_ID = $(shell aws cloudformation describe-stacks \
	--stack-name $(STACK_NAME) --region $(REGION) \
	--query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" \
	--output text 2>/dev/null)

# SSMセッションドキュメント名を取得 (Claude Code強制実行)
SESSION_DOC = $(shell aws cloudformation describe-stacks \
	--stack-name $(STACK_NAME) --region $(REGION) \
	--query "Stacks[0].Outputs[?OutputKey=='SessionDocumentName'].OutputValue" \
	--output text 2>/dev/null)

.PHONY: deploy destroy start stop status connect ssh-cmd logs

deploy:
	cdk deploy --require-approval never

destroy:
	cdk destroy --force

start:
	@echo "Starting instance $(INSTANCE_ID) ..."
	aws ec2 start-instances --instance-ids $(INSTANCE_ID) --region $(REGION)
	@echo "Waiting for running state..."
	aws ec2 wait instance-running --instance-ids $(INSTANCE_ID) --region $(REGION)
	@echo "Instance is running."

stop:
	@echo "Stopping instance $(INSTANCE_ID) ..."
	aws ec2 stop-instances --instance-ids $(INSTANCE_ID) --region $(REGION)
	@echo "Waiting for stopped state..."
	aws ec2 wait instance-stopped --instance-ids $(INSTANCE_ID) --region $(REGION)
	@echo "Instance is stopped."

status:
	@aws ec2 describe-instances \
		--instance-ids $(INSTANCE_ID) --region $(REGION) \
		--query "Reservations[0].Instances[0].State.Name" \
		--output text

connect:
	@INSTANCE_ID=$(INSTANCE_ID); \
	if [ -z "$$INSTANCE_ID" ] || [ "$$INSTANCE_ID" = "None" ]; then \
		echo "ERROR: Instance ID not found. Is the stack deployed?"; exit 1; \
	fi; \
	STATE=$$(aws ec2 describe-instances --instance-ids $$INSTANCE_ID --region $(REGION) \
		--query "Reservations[0].Instances[0].State.Name" --output text); \
	if [ "$$STATE" != "running" ]; then \
		echo "ERROR: Instance is not running (current state: $$STATE). Run 'make start' first."; exit 1; \
	fi; \
	echo "Connecting to $$INSTANCE_ID via SSM (Claude Code)..."; \
	aws ssm start-session --target $$INSTANCE_ID --region $(REGION) --document-name $(SESSION_DOC)

# デバッグ用: セッションドキュメントなしで通常シェルに接続
debug:
	aws ssm start-session --target $(INSTANCE_ID) --region $(REGION)

# SSM接続コマンドを表示するだけ（コピペ用）
ssh-cmd:
	@echo "aws ssm start-session --target $(INSTANCE_ID) --region $(REGION) --document-name $(SESSION_DOC)"

# UserDataのセットアップログを確認
logs:
	@aws ssm start-session \
		--target $(INSTANCE_ID) --region $(REGION) \
		--document-name AWS-StartInteractiveCommand \
		--parameters '{"command":["sudo cat /var/log/cloud-init-output.log"]}'
