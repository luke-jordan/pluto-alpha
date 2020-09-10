variable "referral_use_lambda_function_name" {
  default = "referral_use"
  type = string
}

resource "aws_lambda_function" "referral_use" {

  function_name                  = var.referral_use_lambda_function_name
  role                           = aws_iam_role.referral_use_role.arn
  handler                        = "referral-use-handler.useReferralCode"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 15
  tags                           = {"environment"  = terraform.workspace}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "referral_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
            "aws": {
                "region": var.aws_default_region[terraform.workspace]
            },
            "tables": {
              "activeCodes": aws_dynamodb_table.active_referral_code_table.name
            },
            "publishing": {
              "userEvents": {
                  "topicArn": var.user_event_topic_arn[terraform.workspace]
              },
              "hash": {
                "key": var.log_hashing_secret[terraform.workspace]
              }
            }
        }
      )}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.referral_use, 
    aws_iam_role_policy_attachment.referral_use_basic_execution_policy,
    aws_iam_role_policy_attachment.referral_use_table_read_access_policy]
}

resource "aws_iam_role" "referral_use_role" {
  name = "${var.referral_use_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "referral_use" {
  name = "/aws/lambda/${var.referral_use_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "referral_use_basic_execution_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "referral_use_table_read_access_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = aws_iam_policy.referral_code_read_policy.arn
}

resource "aws_iam_role_policy_attachment" "referral_use_client_float_table_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = aws_iam_policy.dynamo_table_client_float_table_access.arn
}

resource "aws_iam_role_policy_attachment" "referral_use_boost_create_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = aws_iam_policy.lambda_invoke_boost_create_access.arn
}

# should switch these to using lambdas instead of direct read write
resource "aws_iam_role_policy_attachment" "referral_use_profile_table_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = var.user_profile_table_read_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "referral_use_profile_update_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = var.user_profile_table_update_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "referral_use_event_publish_policy" {
  role = aws_iam_role.referral_use_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_referral_use" {
  log_group_name = "${aws_cloudwatch_log_group.referral_use.name}"
  metric_transformation {
    name = "${var.referral_use_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.referral_use_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_referral_use" {
  alarm_name = "${var.referral_use_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_referral_use.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.fatal_errors_topic.arn]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_referral_use" {
  log_group_name = "${aws_cloudwatch_log_group.referral_use.name}"
  metric_transformation {
    name = "${var.referral_use_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.referral_use_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_referral_use" {
  alarm_name = "${var.referral_use_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_referral_use.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}
