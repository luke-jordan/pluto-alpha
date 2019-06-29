variable "update_password_lambda_function_name" {
  default = "update_password"
  type = "string"
}

resource "aws_lambda_function" "update_password" {

  function_name                  = "${var.update_password_lambda_function_name}"
  role                           = "${aws_iam_role.update_password_role.arn}"
  handler                        = "index.updatePassword"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "auth_api/${var.deploy_code_commit_hash}.zip"

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
              "jwt": {
                  "expiresIn": "7d",
                  "algorithm": "RS256"
              },
              "db": {
                  "host": "localhost",
                  "port": "5432",
                  "database": "plutotest",
                  "user": "auth_api_worker",
                  "password": "pwd_for_auth_api_worker"
              },
              "tables": {
                  "userTable": "user_data.user",
                  "dynamoAuthPoliciesTable": "roles_and_permissions"
              },
              "s3": {
                  "Buckets": {
                      "jwtTestBucket": "test-jwt-encryption-keys"
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

  depends_on = [aws_cloudwatch_log_group.update_password]
}

resource "aws_iam_role" "update_password_role" {
  name = "${var.update_password_lambda_function_name}_role"

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

resource "aws_cloudwatch_log_group" "update_password" {
  name = "/aws/lambda/${var.update_password_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}


resource "aws_iam_role_policy_attachment" "update_password_basic_execution_policy" {
  role = "${aws_iam_role.update_password_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "update_password_vpc_execution_policy" {
  role = "${aws_iam_role.update_password_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_update_password" {
  log_group_name = "${aws_cloudwatch_log_group.update_password.name}"
  metric_transformation {
    name = "${var.update_password_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.update_password_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_update_password" {
  alarm_name = "${var.update_password_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_update_password.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_update_password" {
  log_group_name = "${aws_cloudwatch_log_group.update_password.name}"
  metric_transformation {
    name = "${var.update_password_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.update_password_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_update_password" {
  alarm_name = "${var.update_password_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_update_password.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}