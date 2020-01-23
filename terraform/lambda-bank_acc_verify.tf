variable "bank_account_verify_lambda_function_name" {
  default = "bank_account_verify"
  type = "string"
}

resource "aws_lambda_function" "bank_account_verify" {

  function_name                  = "${var.bank_account_verify_lambda_function_name}"
  role                           = "${aws_iam_role.bank_account_verify_role.arn}"
  handler                        = "bank-verify-handler.handle"
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
              "pbVerify": {
                "endpoint": "${var.pbverify_endpoint[terraform.workspace]}",
                "memberKey": "${var.pbverify_member_key[terraform.workspace]}",
                "password": "${var.pbverify_password[terraform.workspace]}"
              },
              "mock": {
                "enabled": "true",
                "result": "VERIFIED"
              }
          }
      )}"
    }
  }
  
  depends_on = [aws_cloudwatch_log_group.bank_account_verify]
}

resource "aws_iam_role" "bank_account_verify_role" {
  name = "${var.bank_account_verify_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "bank_account_verify" {
  name = "/aws/lambda/${var.bank_account_verify_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "bank_account_verify_basic_execution_policy" {
  role = "${aws_iam_role.bank_account_verify_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_bank_account_verify" {
  log_group_name = "${aws_cloudwatch_log_group.bank_account_verify.name}"
  metric_transformation {
    name = "${var.bank_account_verify_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.bank_account_verify_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_bank_account_verify" {
  alarm_name = "${var.bank_account_verify_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_bank_account_verify.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_bank_account_verify" {
  log_group_name = "${aws_cloudwatch_log_group.bank_account_verify.name}"
  metric_transformation {
    name = "${var.bank_account_verify_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.bank_account_verify_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_bank_account_verify" {
  alarm_name = "${var.bank_account_verify_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_bank_account_verify.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}
