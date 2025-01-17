variable "outbound_comms_send_lambda_function_name" {
  default = "outbound_comms_send"
  type = "string"
}

resource "aws_lambda_function" "outbound_comms_send" {

  function_name                  = "${var.outbound_comms_send_lambda_function_name}"
  role                           = "${aws_iam_role.outbound_comms_send_role.arn}"
  handler                        = "outbound-message-handler.handleOutboundMessages"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 180
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "third_parties/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "sendgrid": {
                "apiKey": "${var.sendgrid_api_key[terraform.workspace]}",
                "fromAddress": "${var.messaging_source_email_address[terraform.workspace]}",
                "replyToAddress": "${var.messaging_source_email_address[terraform.workspace]}",
                "sandbox": {
                  "off": terraform.workspace == "master"
                }
              },
              "twilio": {
                "accountSid": "${var.twilio_sid[terraform.workspace]}",
                "authToken": "${var.twilio_token[terraform.workspace]}",
                "number": "${var.twilio_number[terraform.workspace]}",
                "mock": "OFF"
              },
              "retry": {
                "initialPeriod": 3000,
                "maxRetries": 5,
                "maxRetryTime": 120000
              }
          }
      )}"
    }
  }
  
  depends_on = [aws_cloudwatch_log_group.outbound_comms_send]
}

resource "aws_iam_role" "outbound_comms_send_role" {
  name = "${var.outbound_comms_send_lambda_function_name}_role_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_cloudwatch_log_group" "outbound_comms_send" {
  name = "/aws/lambda/${var.outbound_comms_send_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "outbound_comms_send_basic_execution_policy" {
  role = aws_iam_role.outbound_comms_send_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "outbound_comms_send_template_access_policy" {
  role = aws_iam_role.outbound_comms_send_role.name
  policy_arn = aws_iam_policy.templates_s3_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_outbound_comms_send" {
  log_group_name = "${aws_cloudwatch_log_group.outbound_comms_send.name}"
  metric_transformation {
    name = "${var.outbound_comms_send_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.outbound_comms_send_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_outbound_comms_send" {
  alarm_name = "${var.outbound_comms_send_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_outbound_comms_send.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_outbound_comms_send" {
  log_group_name = "${aws_cloudwatch_log_group.outbound_comms_send.name}"
  metric_transformation {
    name = "${var.outbound_comms_send_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.outbound_comms_send_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_outbound_comms_send" {
  alarm_name = "${var.outbound_comms_send_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_outbound_comms_send.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}
