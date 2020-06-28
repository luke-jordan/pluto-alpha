variable "admin_user_file_store_lambda_function_name" {
  default = "admin_user_file_store"
  type = "string"
}

resource "aws_lambda_function" "admin_user_file_store" {

  function_name                  = "${var.admin_user_file_store_lambda_function_name}"
  role                           = "${aws_iam_role.admin_user_file_store_role.arn}"
  handler                        = "admin-user-logging.uploadLogBinary"
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
              "publishing": {
                "userEvents": {
                    "topicArn": "${var.user_event_topic_arn[terraform.workspace]}"
                },
                "hash": {
                  "key": "${var.log_hashing_secret[terraform.workspace]}"
                }
              },
          }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.admin_user_file_store]
}

resource "aws_iam_role" "admin_user_file_store_role" {
  name = "${var.admin_user_file_store_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "admin_user_file_store" {
  name = "/aws/lambda/${var.admin_user_file_store_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_basic_execution_policy" {
  role = "${aws_iam_role.admin_user_file_store_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_vpc_execution_policy" {
  role = "${aws_iam_role.admin_user_file_store_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_profile_invoke_policy" {
  role = "${aws_iam_role.admin_user_file_store_role.name}"
  policy_arn = "${var.user_profile_admin_policy_arn[terraform.workspace]}"
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_event_publish" {
  role = aws_iam_role.admin_user_file_store_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_pword_update" {
  role = aws_iam_role.admin_user_file_store_role.name
  policy_arn = var.pword_update_policy[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_omnibus" {
  role = aws_iam_role.admin_user_file_store_role.name
  policy_arn = aws_iam_policy.admin_user_file_store_lambda_policy.arn
}

resource "aws_iam_role_policy_attachment" "admin_user_file_store_secret_get" {
  role = "${aws_iam_role.admin_user_file_store_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_admin_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_admin_user_file_store" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_file_store.name}"
  metric_transformation {
    name = "${var.admin_user_file_store_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_file_store_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_admin_user_file_store" {
  alarm_name = "${var.admin_user_file_store_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_admin_user_file_store.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_admin_user_file_store" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_file_store.name}"
  metric_transformation {
    name = "${var.admin_user_file_store_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_file_store_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_admin_user_file_store" {
  alarm_name = "${var.admin_user_file_store_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_admin_user_file_store.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}
