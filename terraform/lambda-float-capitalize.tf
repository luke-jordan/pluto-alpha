variable "float_capitalize_lambda_function_name" {
  default = "float_capitalize"
  type = "string"
}

resource "aws_lambda_function" "float_capitalize" {

  function_name                  = "${var.float_capitalize_lambda_function_name}"
  role                           = "${aws_iam_role.float_capitalize_role.arn}"
  handler                        = "capitalization-handler.handle"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "float_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws"= {
                "region"= "${var.aws_default_region[terraform.workspace]}",
                "endpoints"= {
                    "dynamodb"= null
                }
            },
            "variableKeys"= {
                "bonusPoolShare"= "bonus_pool_accrual_share",
                "companyShare"= "company_accrual_share"
            },
            "secrets": {
                "enabled": true,
                "names": {
                    "float_api_worker": "${terraform.workspace}/ops/psql/float"
                }
            },
            "db": {
              "host": "${local.database_config.host}",
              "database": "${local.database_config.database}",
              "port" :"${local.database_config.port}"
            },
            "records": {
              "bucket": "${aws_s3_bucket.float_record_bucket.bucket}"
            }
        }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.float_capitalize]
}

resource "aws_iam_role" "float_capitalize_role" {
  name = "${var.float_capitalize_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "float_capitalize" {
  name = "/aws/lambda/${var.float_capitalize_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "float_capitalize_basic_execution_policy" {
  role = "${aws_iam_role.float_capitalize_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "float_capitalize_vpc_execution_policy" {
  role = "${aws_iam_role.float_capitalize_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "float_capitalize_client_float_table_access" {
  role = "${aws_iam_role.float_capitalize_role.name}"
  policy_arn = "${aws_iam_policy.dynamo_table_client_float_table_access.arn}"
}

resource "aws_iam_role_policy_attachment" "float_capitalize_s3_put_access" {
  role = aws_iam_role.float_capitalize_role.name
  policy_arn = aws_iam_policy.float_record_s3_access.arn
}

resource "aws_iam_role_policy_attachment" "float_capitalize_secret_get" {
  role = "${aws_iam_role.float_capitalize_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_float_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_float_capitalize" {
  log_group_name = "${aws_cloudwatch_log_group.float_capitalize.name}"
  metric_transformation {
    name = "${var.float_capitalize_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_capitalize_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_float_capitalize" {
  alarm_name = "${var.float_capitalize_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_float_capitalize.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_float_capitalize" {
  log_group_name = "${aws_cloudwatch_log_group.float_capitalize.name}"
  metric_transformation {
    name = "${var.float_capitalize_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_capitalize_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_float_capitalize" {
  alarm_name = "${var.float_capitalize_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_float_capitalize.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}
