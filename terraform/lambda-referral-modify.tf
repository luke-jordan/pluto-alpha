variable "referral_modify_lambda_function_name" {
  default = "referral_modify"
  type = "string"
}

resource "aws_lambda_function" "referral_modify" {

  function_name                  = "${var.referral_modify_lambda_function_name}"
  role                           = "${aws_iam_role.referral_modify_role.arn}"
  handler                        = "referral-handler.modify"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "referral_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
            }
        }
      )}"
    }
  }

  depends_on = [aws_cloudwatch_log_group.referral_modify]
}

resource "aws_iam_role" "referral_modify_role" {
  name = "${var.referral_modify_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "referral_modify" {
  name = "/aws/lambda/${var.referral_modify_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "referral_modify_basic_execution_policy" {
  role = "${aws_iam_role.referral_modify_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "referral_modify_table_read_policy" {
  role = aws_iam_role.referral_modify_role.name
  policy_arn = aws_iam_policy.referral_code_read_policy.arn
}

resource "aws_iam_role_policy_attachment" "referral_modify_table_write_policy" {
  role = aws_iam_role.referral_modify_role.name
  policy_arn = aws_iam_policy.referral_code_write_policy.arn
}

resource "aws_iam_role_policy_attachment" "referral_modify_archive_update_policy" {
  role = aws_iam_role.referral_modify_role.name
  policy_arn = aws_iam_policy.referral_code_deactivate_policy.arn
}

resource "aws_iam_role_policy_attachment" "referral_modify_client_float_table_policy" {
  role = aws_iam_role.referral_modify_role.name
  policy_arn = aws_iam_policy.dynamo_table_client_float_table_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_referral_modify" {
  log_group_name = "${aws_cloudwatch_log_group.referral_modify.name}"
  metric_transformation {
    name = "${var.referral_modify_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.referral_modify_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_referral_modify" {
  alarm_name = "${var.referral_modify_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_referral_modify.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_referral_modify" {
  log_group_name = "${aws_cloudwatch_log_group.referral_modify.name}"
  metric_transformation {
    name = "${var.referral_modify_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.referral_modify_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_referral_modify" {
  alarm_name = "${var.referral_modify_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_referral_modify.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}