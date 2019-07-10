variable "account_balance_lambda_function_name" {
  default = "account_balance"
  type = "string"
}

resource "aws_lambda_function" "account_balance_lambda" {

  function_name                  = "${var.account_balance_lambda_function_name}"
  role                           = "${aws_iam_role.account_balance_lambda_role.arn}"
  handler                        = "handler.balance"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.account_balance_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}",
                "apiVersion": "2012-08-10",
                "endpoints": {
                    "dynamodb": null
                }
            },
            "tables": {
                "dynamodb": "CoreAccountLedger",
                "accountData": "account_data.core_account_ledger"
            },
            "db": {
                "user": "account_api_worker",
                "host": "localhost",
                "database": "pluto",
                "password": "pwd_for_account_api",
                "port" :"5430"
            },
            "test": {
                "nock": {
                    "dynamodb": "http://localhost:4569"
                }
            }
        }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.account_balance_lambda]
}

resource "aws_iam_role" "account_balance_lambda_role" {
  name = "${var.user_existence_api_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "account_balance_lambda" {
  name = "/aws/lambda/${var.user_existence_api_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "account_balance_lambda_basic_execution_policy" {
  role = "${aws_iam_role.account_balance_lambda_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "account_balance_lambda_vpc_execution_policy" {
  role = "${aws_iam_role.account_balance_lambda_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_account_balance_lambda" {
  log_group_name = "${aws_cloudwatch_log_group.account_balance_lambda.name}"
  metric_transformation {
    name = "${var.account_balance_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.account_balance_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_account_balance_lambda" {
  alarm_name = "${var.account_balance_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_account_balance_lambda.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_account_balance_lambda" {
  log_group_name = "${aws_cloudwatch_log_group.account_balance_lambda.name}"
  metric_transformation {
    name = "${var.account_balance_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.account_balance_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_account_balance_lambda" {
  alarm_name = "${var.account_balance_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_account_balance_lambda.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}