variable "account_create_lambda_function_name" {
  default = "account_create"
  type = string
}

resource "aws_lambda_function" "account_create" {

  function_name                  = "${var.account_create_lambda_function_name}"
  role                           = "${aws_iam_role.account_create_role.arn}"
  handler                        = "account-handler.create"
  memory_size                    = 512
  runtime                        = "nodejs12.x"
  timeout                        = 30
  tags                           = {"environment"  = terraform.workspace}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "user_existence_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}",
                "endpoints": {
                    "dynamodb": null
                }
            },
            "tables": {
                "dynamodb": "CoreAccountLedger",
                "accountData": "account_data.core_account_ledger"
            },
            "db": {
              "host": "${local.database_config.host}",
              "database": "${local.database_config.database}",
              "port" :"${local.database_config.port}"
            },
            "secrets": {
                "enabled": true,
                "names": {
                    "account_api_worker": "${terraform.workspace}/ops/psql/accounts"
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

  depends_on = [aws_cloudwatch_log_group.account_create]
}

resource "aws_iam_role" "account_create_role" {
  name = "${var.account_create_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "account_create" {
  name = "/aws/lambda/${var.account_create_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "account_create_basic_execution_policy" {
  role = "${aws_iam_role.account_create_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "account_create_vpc_execution_policy" {
  role = "${aws_iam_role.account_create_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "account_create_secret_get" {
  role = "${aws_iam_role.account_create_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_account_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_account_create" {
  log_group_name = "${aws_cloudwatch_log_group.account_create.name}"
  metric_transformation {
    name = "${var.account_create_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.account_create_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_account_create" {
  alarm_name = "${var.account_create_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_account_create.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_account_create" {
  log_group_name = "${aws_cloudwatch_log_group.account_create.name}"
  metric_transformation {
    name = "${var.account_create_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.account_create_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_account_create" {
  alarm_name = "${var.account_create_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_account_create.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}