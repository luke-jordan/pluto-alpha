variable "float_transfer_lambda_function_name" {
  default = "float_transfer"
  type = "string"
}

resource "aws_lambda_function" "float_transfer" {

  function_name                  = "${var.float_transfer_lambda_function_name}"
  role                           = "${aws_iam_role.float_transfer_role.arn}"
  handler                        = "index.handler"
  memory_size                    = 256
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.float_transfer_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

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
            "secrets": {
                "enabled": true,
                "names": {
                    "float_api_worker": "${terraform.workspace}/ops/psql/float"
                }
            },
            "db": {
                "host": "${aws_db_instance.rds[0].address}",
                "database": "${var.db_name}",
                "port" :"${aws_db_instance.rds[0].port}"
            }
        }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.float_transfer]
}

resource "aws_iam_role" "float_transfer_role" {
  name = "${var.float_transfer_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "float_transfer" {
  name = "/aws/lambda/${var.float_transfer_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "float_transfer_basic_execution_policy" {
  role = "${aws_iam_role.float_transfer_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "float_transfer_vpc_execution_policy" {
  role = "${aws_iam_role.float_transfer_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_float_transfer" {
  log_group_name = "${aws_cloudwatch_log_group.float_transfer.name}"
  metric_transformation {
    name = "${var.float_transfer_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_transfer_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_float_transfer" {
  alarm_name = "${var.float_transfer_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_float_transfer.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_float_transfer" {
  log_group_name = "${aws_cloudwatch_log_group.float_transfer.name}"
  metric_transformation {
    name = "${var.float_transfer_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.float_transfer_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_float_transfer" {
  alarm_name = "${var.float_transfer_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_float_transfer.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}



