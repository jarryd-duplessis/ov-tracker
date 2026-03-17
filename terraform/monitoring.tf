# ─── SNS TOPIC FOR ALARMS ────────────────────────────────────────────────────
# Subscribe an email/Slack endpoint manually after deploy.

resource "aws_sns_topic" "alerts" {
  name = "${var.app_name}-alerts"
}

# ─── LAMBDA ERROR ALARMS ────────────────────────────────────────────────────

locals {
  lambda_functions = {
    connect         = aws_lambda_function.connect.function_name
    disconnect      = aws_lambda_function.disconnect.function_name
    ws_message      = aws_lambda_function.ws_message.function_name
    poll            = aws_lambda_function.poll.function_name
    http_stops      = aws_lambda_function.http_stops.function_name
    http_departures = aws_lambda_function.http_departures.function_name
    http_vehicles   = aws_lambda_function.http_vehicles.function_name
    http_journey    = aws_lambda_function.http_journey.function_name
    refresh_stops   = aws_lambda_function.refresh_stops.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_functions

  alarm_name          = "${each.value}-errors"
  alarm_description   = "Errors > 0 for Lambda ${each.value}"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ─── SQS DLQ ALARM ──────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "${aws_sqs_queue.poll_dlq.name}-visible-messages"
  alarm_description   = "Messages visible in DLQ > 0"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.poll_dlq.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
