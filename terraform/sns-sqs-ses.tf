resource "aws_sns_topic" "fatal_errors_topic" {
  name = "fatal_errors_topic"
  display_name = "fatal_errors_topic"
}


resource "aws_sns_topic" "security_errors_topic" {
  name = "security_errors_topic"
  display_name = "security_errors_topic"
}

///////////////// FOR EVENT HANDLING (E.G., SAVES, ETC) //////////////
resource "aws_sqs_queue" "user_event_dlq" {
  name = "${terraform.workspace}_user_event_process_dlq"
  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_user_event_dlq" {
  alarm_name = "event_processor_dlq_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "NumberOfMessagesSent"
  namespace = "AWS/SQS"
  period = 60
  threshold = 0
  statistic = "Sum"

  dimensions = {
    QueueName = aws_sqs_queue.user_event_dlq.name
  }

  alarm_actions = [aws_sns_topic.fatal_errors_topic.arn]
}

resource "aws_sns_topic" "withdrawal_backup_topic" {
  name = "${terraform.workspace}_withdrawal_backup_topic"
  display_name = "${terraform.workspace}_withdrawal_backup_topic"
}

///////////////// SQS QUEUE TO PREVENT LAMBDA EXPLOSION FROM SNS //////////////
resource "aws_sqs_queue" "message_event_process_queue" {
  name = "${terraform.workspace}_message_processing_event_queue"
  visibility_timeout_seconds = 4500
  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_sqs_queue_policy" "message_event_process_queue_policy" {
  queue_url = aws_sqs_queue.message_event_process_queue.id

  policy = <<POLICY
{
  "Version": "2012-10-17",
  "Id": "sqspolicy",
  "Statement": [
    {
      "Sid": "First",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "sqs:SendMessage",
      "Resource": "${aws_sqs_queue.message_event_process_queue.arn}",
      "Condition": {
        "ArnEquals": {
          "aws:SourceArn": "${var.user_event_topic_arn[terraform.workspace]}"
        }
      }
    }
  ]
}
POLICY
}

resource "aws_sns_topic_subscription" "message_event_process_queue" {
  topic_arn = var.user_event_topic_arn[terraform.workspace]
  protocol = "sqs"
  endpoint = aws_sqs_queue.message_event_process_queue.arn

  filter_policy = "${jsonencode({
    "eventType": [
      {
        "anything-but": ["MESSAGE_CREATED", "MESSAGE_FETCHED", "MESSAGE_PUSH_NOTIFICATION_SENT", "MESSAGE_SENT", "BOOST_CREATED_GAME", "BOOST_CREATED_SIMPLE", "BOOST_EXPIRED"]
      }
    ]
  })}"
}
