#!/bin/bash
# Executado pelo LocalStack quando está pronto (/etc/localstack/init/ready.d).
set -euo pipefail

echo "[init] creating SQS FIFO queues"

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" >/dev/null

awslocal sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true >/dev/null

echo "[init] queues ready:"
awslocal sqs list-queues
