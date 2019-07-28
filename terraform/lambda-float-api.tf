variable "float_api_lambda_function_name" {
  default = "float_api"
  type = "string"
}

resource "aws_lambda_function" "float_api" {

  function_name                  = "${var.float_api_lambda_function_name}"
  role                           = "${aws_iam_role.float_api_role.arn}"
  handler                        = "index.handler"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.float_api_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws"= {
                "region"= "${var.aws_default_region[terraform.workspace]}",
                "apiVersion"= "2012-08-10",
                "endpoints"= {
                    "dynamodb"= null
                }
            },
            "tables"= {
                "clientFloatVars"= "ClientFloatTable",
                "floatTransactions"= "float_data.float_transaction_ledger",
                "accountTransactions"= "account_data.core_account_ledger"
            },
            "variableKeys"= {
                "bonusPoolShare"= "bonus_pool_accrual_share",
                "companyShare"= "company_accrual_share"
            },
            "db"= {
                
            }
        }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.float_api]
}

resource "aws_iam_role" "float_api_role" {
  name = "${var.float_api_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "float_api" {
  name = "/aws/lambda/${var.float_api_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "float_api_basic_execution_policy" {
  role = "${aws_iam_role.float_api_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "float_api_vpc_execution_policy" {
  role = "${aws_iam_role.float_api_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "float_api_client_float_table_access" {
  role = "${aws_iam_role.float_api_role.name}"
  policy_arn = "${aws_iam_policy.dynamo_table_client_float_table_access.arn}"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_float_api" {
  log_group_name = "${aws_cloudwatch_log_group.float_api.name}"
  metric_transformation {
    name = "${var.float_api_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_api_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_float_api" {
  alarm_name = "${var.float_api_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_float_api.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_float_api" {
  log_group_name = "${aws_cloudwatch_log_group.float_api.name}"
  metric_transformation {
    name = "${var.float_api_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_api_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_float_api" {
  alarm_name = "${var.float_api_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_float_api.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}



