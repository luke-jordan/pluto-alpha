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

//////////////// FOR EMAIL BOUNCES, ETC /////////////////////////////

# resource "aws_sns_topic" "sns_bounces_topic" {
#   name = "${terraform.workspace}_mail_bounce_topic"
#   tags = {
#     environment = "${terraform.workspace}"
#   }
# }

# resource "aws_sns_topic" "sns_complaints_topic" {
#   name = "${terraform.workspace}_mail_complaint_topic"
#   tags = {
#     environment = "${terraform.workspace}"
#   }
# }

# resource "aws_ses_domain_identity" "primary_email_domain" {
#   domain = "${terraform.workspace}.jupiterapp.net"
# }

# resource "aws_ses_email_identity" "outbound_email_identity" {
#   email = "noreply@jupitersave.com"
# }

