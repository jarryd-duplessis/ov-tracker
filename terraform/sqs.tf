# One standard SQS queue for all poll groups.
# Messages carry { groupKey, stopCodes } as the payload.
# DelaySeconds on each message implements the 15-second polling interval.
# The poll Lambda re-sends a new message after each successful fetch,
# creating a self-sustaining per-group heartbeat.
# When a group has no subscribers, the Lambda doesn't re-send → group stops.
#
# No separate queue per stop group is needed — groupKey in the message body
# lets a single queue serve all groups.

resource "aws_sqs_queue" "poll" {
  name                       = "${var.app_name}-poll"
  # Max delay per message (SQS limit is 900s = 15 min, but we use 15s per send)
  delay_seconds              = 0
  # Messages that fail repeatedly go here for inspection
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.poll_dlq.arn
    maxReceiveCount     = 3
  })
  # Visibility timeout must be > Lambda timeout to prevent duplicate processing
  visibility_timeout_seconds = 90
  message_retention_seconds  = 3600 # 1h — poll messages are short-lived
}

resource "aws_sqs_queue" "poll_dlq" {
  name                      = "${var.app_name}-poll-dlq"
  message_retention_seconds = 86400 # 1 day
}

# Allow the poll Lambda's execution role to send/receive from the queue
resource "aws_sqs_queue_policy" "poll" {
  queue_url = aws_sqs_queue.poll.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.lambda_poll.arn }
      Action    = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource  = aws_sqs_queue.poll.arn
    }]
  })
}
