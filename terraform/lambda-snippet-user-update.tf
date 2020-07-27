variable "snippet_user_update_lambda_function_name" {
  default = "snippet_user_update"
  type = "string"
}

resource "aws_lambda_function" "snippet_user_update" {

  function_name                  = var.snippet_user_update_lambda_function_name
  role                           = aws_iam_role.snippet_user_update_role.arn
  handler                        = "snippet-handler.handleSnippetStatusUpdates"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 15
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "snippet_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": var.aws_default_region[terraform.workspace]
              },
              "db": {
                "host": local.database_config.host,
                "database": local.database_config.database,
                "port" : local.database_config.port
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "snippet_worker": "${terraform.workspace}/ops/psql/snippet"
                }
              },
              "publishing": {
                "snippetQueue": aws_sqs_queue.snippet_update_queue.name
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.snippet_user_update]
}

resource "aws_iam_role" "snippet_user_update_role" {
  name = "${var.snippet_user_update_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "snippet_user_update" {
  name = "/aws/lambda/${var.snippet_user_update_lambda_function_name}"
  retention_in_days = 7

  tags = {
    environment = terraform.workspace
  }
}

/////////////////// IAM CONFIG //////////////////////////////////////////////////////////////////////////////////////

resource "aws_iam_role_policy_attachment" "snippet_user_update_basic_execution_policy" {
  role = aws_iam_role.snippet_user_update_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "snippet_user_update_vpc_execution_policy" {
  role = aws_iam_role.snippet_user_update_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "snippet_user_update_queue_publish_policy" {
  role = aws_iam_role.snippet_user_update_role.name
  policy_arn = aws_iam_policy.sqs_snippet_update_queue_publish.arn
}

resource "aws_iam_role_policy_attachment" "snippet_user_update_secret_get" {
  role = aws_iam_role.snippet_user_update_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_snippet_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_snippet_user_update" {
  log_group_name = aws_cloudwatch_log_group.snippet_user_update.name
  metric_transformation {
    name = "${var.snippet_user_update_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.snippet_user_update_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_snippet_user_update" {
  alarm_name = "${var.snippet_user_update_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = aws_cloudwatch_log_metric_filter.fatal_metric_filter_snippet_user_update.name
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.fatal_errors_topic.arn]
}
