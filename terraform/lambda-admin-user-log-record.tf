variable "admin_user_log_fetch_lambda_function_name" {
  default = "admin_user_log_fetch"
  type = "string"
}

resource "aws_lambda_function" "admin_user_log_fetch" {

  function_name                  = "${var.admin_user_log_fetch_lambda_function_name}"
  role                           = "${aws_iam_role.admin_user_log_fetch_role.arn}"
  handler                        = "admin-user-manage.manageUser"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 30
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "admin_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                  "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "binaries": {
                "s3": {
                  "bucket": "${aws_s3_bucket.user_record_bucket.bucket}"
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

  depends_on = [aws_cloudwatch_log_group.admin_user_log_fetch]
}

resource "aws_iam_role" "admin_user_log_fetch_role" {
  name = "${var.admin_user_log_fetch_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "admin_user_log_fetch" {
  name = "/aws/lambda/${var.admin_user_log_fetch_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "admin_user_log_fetch_basic_execution_policy" {
  role = "${aws_iam_role.admin_user_log_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_log_fetch_vpc_execution_policy" {
  role = "${aws_iam_role.admin_user_log_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_log_fetch_file_get" {
  role = aws_iam_role.admin_user_log_fetch_role.name
  policy_arn = aws_iam_policy.user_record_bucket_put.arn
}

resource "aws_iam_role_policy_attachment" "admin_user_log_fetch_read" {
  role = aws_iam_role.admin_user_log_fetch_role.name
  policy_arn = aws_iam_policy.fetch_user_log_full.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_admin_user_log_fetch" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_log_fetch.name}"
  metric_transformation {
    name = "${var.admin_user_log_fetch_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_log_fetch_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_admin_user_log_fetch" {
  alarm_name = "${var.admin_user_log_fetch_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_admin_user_log_fetch.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_admin_user_log_fetch" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_log_fetch.name}"
  metric_transformation {
    name = "${var.admin_user_log_fetch_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_log_fetch_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_admin_user_log_fetch" {
  alarm_name = "${var.admin_user_log_fetch_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_admin_user_log_fetch.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}
