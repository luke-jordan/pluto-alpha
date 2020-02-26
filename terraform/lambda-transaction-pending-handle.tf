variable "transaction_pending_handle_lambda_function_name" {
  default = "transaction_pending_handle"
  type = "string"
}

resource "aws_lambda_function" "transaction_pending_handle" {

  function_name                  = "${var.transaction_pending_handle_lambda_function_name}"
  role                           = "${aws_iam_role.transaction_pending_handle_role.arn}"
  handler                        = "pending-handler.handlePendingTxEvent"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 60
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "user_activity_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "db": {
                "host": "${local.database_config.host}",
                "database": "${local.database_config.database}",
                "port" :"${local.database_config.port}"
              },
              "secrets": {
                "enabled": true,
                "names": {
                  "save_tx_api_worker": "${terraform.workspace}/ops/psql/transactions"
                }
              },
              "publishing": {
                "userEvents": {
                    "topicArn": "${var.user_event_topic_arn[terraform.workspace]}"
                },
                "hash": {
                  "key": "${var.log_hashing_secret[terraform.workspace]}"
                }
              },
              "payment": {
                "test": terraform.workspace == "staging"
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.transaction_pending_handle]
}

resource "aws_iam_role" "transaction_pending_handle_role" {
  name = "${var.transaction_pending_handle_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "transaction_pending_handle" {
  name = "/aws/lambda/${var.transaction_pending_handle_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_basic_execution_policy" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_vpc_execution_policy" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_user_event_publish_policy" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_payment_url_get" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = aws_iam_policy.lambda_invoke_payment_access.arn
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_secret_get" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_transaction_worker_read"
}

resource "aws_iam_role_policy_attachment" "transaction_pending_handle_check_float_details" {
  role = aws_iam_role.transaction_pending_handle_role.name
  policy_arn = aws_iam_policy.dynamo_table_client_float_table_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_transaction_pending_handle" {
  log_group_name = aws_cloudwatch_log_group.transaction_pending_handle.name
  metric_transformation {
    name = "${var.transaction_pending_handle_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.transaction_pending_handle_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_transaction_pending_handle" {
  alarm_name = "${var.transaction_pending_handle_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = aws_cloudwatch_log_metric_filter.fatal_metric_filter_transaction_pending_handle.name
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.fatal_errors_topic.arn]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_transaction_pending_handle" {
  log_group_name = aws_cloudwatch_log_group.transaction_pending_handle.name
  metric_transformation {
    name = "${var.transaction_pending_handle_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.transaction_pending_handle_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_transaction_pending_handle" {
  alarm_name = "${var.transaction_pending_handle_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = aws_cloudwatch_log_metric_filter.security_metric_filter_transaction_pending_handle.name
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}