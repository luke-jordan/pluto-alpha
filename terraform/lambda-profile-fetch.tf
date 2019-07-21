variable "profile_fetch_lambda_function_name" {
  default = "profile_fetch"
  type = "string"
}

resource "aws_lambda_function" "profile_fetch" {

  function_name                  = "${var.profile_fetch_lambda_function_name}"
  role                           = "${aws_iam_role.profile_fetch_role.arn}"
  handler                        = "profile-handler.fetchUserBySystemId"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
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
                "apiVersion": "2012-08-10",
                "endpoints": {
                    "dynamodb": null
                }
            },
            "tables": {
              "dynamo": {
                  "profileTable": "UserProfileTable",
                  "nationalIdTable": "UserNationalIdTable",
                  "phoneTable": "UserPhoneTable",
                  "emailTable": "UserEmailTable"
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

  depends_on = [aws_cloudwatch_log_group.profile_fetch]
}

resource "aws_iam_role" "profile_fetch_role" {
  name = "${var.profile_fetch_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "profile_fetch" {
  name = "/aws/lambda/${var.profile_fetch_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "profile_fetch_basic_execution_policy" {
  role = "${aws_iam_role.profile_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "profile_fetch_vpc_execution_policy" {
  role = "${aws_iam_role.profile_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "profile_fetch_table_access_policy" {
  role = "${aws_iam_role.profile_fetch_role.name}"
  policy_arn = "${aws_iam_policy.dynamo_table_UserProfileTableRead_access.arn}"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_profile_fetch" {
  log_group_name = "${aws_cloudwatch_log_group.profile_fetch.name}"
  metric_transformation {
    name = "${var.profile_fetch_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.profile_fetch_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_profile_fetch" {
  alarm_name = "${var.profile_fetch_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_profile_fetch.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_profile_fetch" {
  log_group_name = "${aws_cloudwatch_log_group.profile_fetch.name}"
  metric_transformation {
    name = "${var.profile_fetch_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.profile_fetch_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_profile_fetch" {
  alarm_name = "${var.profile_fetch_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_profile_fetch.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}