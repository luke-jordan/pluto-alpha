variable "email_send_lambda_function_name" {
  default = "email_send"
  type = "string"
}

resource "aws_lambda_function" "email_send" {

  function_name                  = "${var.email_send_lambda_function_name}"
  role                           = "${aws_iam_role.email_send_role.arn}"
  handler                        = "email-handler.sendEmailMessages"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 15
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
              }
          }
      )}"
    }
  }
  
  depends_on = [aws_cloudwatch_log_group.email_send]
}

resource "aws_iam_role" "email_send_role" {
  name = "${var.email_send_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "email_send" {
  name = "/aws/lambda/${var.email_send_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "email_send_basic_execution_policy" {
  role = aws_iam_role.email_send_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "email_send_template_access_policy" {
  role = aws_iam_role.email_send_role.name
  policy_arn = aws_iam_policy.templates_s3_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_email_send" {
  log_group_name = "${aws_cloudwatch_log_group.email_send.name}"
  metric_transformation {
    name = "${var.email_send_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.email_send_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_email_send" {
  alarm_name = "${var.email_send_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_email_send.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_email_send" {
  log_group_name = "${aws_cloudwatch_log_group.email_send.name}"
  metric_transformation {
    name = "${var.email_send_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.email_send_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_email_send" {
  alarm_name = "${var.email_send_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_email_send.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}