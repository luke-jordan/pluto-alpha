variable "balance_sheet_acc_update_lambda_function_name" {
  default = "balance_sheet_acc_update"
  type = "string"
}

resource "aws_lambda_function" "balance_sheet_acc_update" {

  function_name                  = "${var.balance_sheet_acc_update_lambda_function_name}"
  role                           = "${aws_iam_role.balance_sheet_acc_update_role.arn}"
  handler                        = "finworks-handler.addTransaction"
  memory_size                    = 128
  runtime                        = "nodejs12.x"
  timeout                        = 60
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "third_parties/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "finworks": {
                "endpoints": {
                  "rootUrl": "${var.finworks_root_url[terraform.workspace]}",
                },
                "s3": {
                  "bucket": "${terraform.workspace}.jupiter.keys",
                  "crt": "finworks/fwjupiter.${terraform.workspace}.crt",
                  "pem": "finworks/fwjupiter.${terraform.workspace}.key"
                }
              }
          }
      )}"
    }
  }
  
  depends_on = [aws_cloudwatch_log_group.balance_sheet_acc_update]
}

resource "aws_iam_role" "balance_sheet_acc_update_role" {
  name = "${var.balance_sheet_acc_update_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "balance_sheet_acc_update" {
  name = "/aws/lambda/${var.balance_sheet_acc_update_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "balance_sheet_acc_update_basic_execution_policy" {
  role = "${aws_iam_role.balance_sheet_acc_update_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "balance_sheet_acc_update_key_access" {
  role = aws_iam_role.balance_sheet_acc_update_role.name
  policy_arn = aws_iam_policy.fworks_s3_access.arn
}

resource "aws_iam_role_policy_attachment" "balance_sheet_update_queue_polling_policy" {
  role = aws_iam_role.balance_sheet_acc_update_role.name
  policy_arn = aws_iam_policy.sqs_bsheet_update_queue_poll.arn
}

////////////////// SUBSCRIPTION TO TOPIC (VIA QUEUE) /////////////////////////////////////////////////////////////

resource "aws_lambda_event_source_mapping" "bsheet_event_process_lambda" {
  event_source_arn = aws_sqs_queue.balance_sheet_update_queue.arn
  enabled = true
  function_name = aws_lambda_function.balance_sheet_acc_update.arn
  batch_size = 1 // for the moment
  # maximum_batching_window_in_seconds = 2 // to prevent over eagerness here (but looks like not accepted here yet)
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_balance_sheet_acc_update" {
  log_group_name = "${aws_cloudwatch_log_group.balance_sheet_acc_update.name}"
  metric_transformation {
    name = "${var.balance_sheet_acc_update_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.balance_sheet_acc_update_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_balance_sheet_acc_update" {
  alarm_name = "${var.balance_sheet_acc_update_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_balance_sheet_acc_update.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_balance_sheet_acc_update" {
  log_group_name = "${aws_cloudwatch_log_group.balance_sheet_acc_update.name}"
  metric_transformation {
    name = "${var.balance_sheet_acc_update_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.balance_sheet_acc_update_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_balance_sheet_acc_update" {
  alarm_name = "${var.balance_sheet_acc_update_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_balance_sheet_acc_update.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}
