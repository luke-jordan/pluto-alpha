variable "withdraw_end_lambda_function_name" {
  default = "withdraw_end"
  type = string
}

resource "aws_lambda_function" "withdraw_end" {

  function_name                  = "${var.withdraw_end_lambda_function_name}"
  role                           = "${aws_iam_role.withdraw_end_role.arn}"
  handler                        = "withdrawal-handler.confirmWithdrawal"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 15
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
              "cache": {
                "host": "${aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.address}",
                "port": "${aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.port}"
              },
              "tables": {
                "bankVerification": "${aws_dynamodb_table.bank_verification_hash.name}"
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
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, 
      aws_security_group.sg_ops_cache_access.id, aws_security_group.sg_cache_6379_ingress.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.withdraw_end]
}

resource "aws_iam_role" "withdraw_end_role" {
  name = "${var.withdraw_end_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "withdraw_end" {
  name = "/aws/lambda/${var.withdraw_end_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "withdraw_end_basic_execution_policy" {
  role = "${aws_iam_role.withdraw_end_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "withdraw_end_vpc_execution_policy" {
  role = "${aws_iam_role.withdraw_end_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "withdraw_end_bank_verify_invoke_policy" {
  role = aws_iam_role.withdraw_end_role.name
  policy_arn = aws_iam_policy.lamdba_invoke_bank_verify_access.arn
}

resource "aws_iam_role_policy_attachment" "withdraw_end_user_event_publish_policy" {
  role = "${aws_iam_role.withdraw_end_role.name}"
  policy_arn = "${aws_iam_policy.ops_sns_user_event_publish.arn}"
}

resource "aws_iam_role_policy_attachment" "withdraw_end_secret_get" {
  role = "${aws_iam_role.withdraw_end_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_transaction_worker_read"
}

resource "aws_iam_role_policy_attachment" "withdraw_end_bank_hash" {
  role = aws_iam_role.withdraw_end_role.name
  policy_arn = aws_iam_policy.dynamo_bank_verification_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_withdraw_end" {
  log_group_name = "${aws_cloudwatch_log_group.withdraw_end.name}"
  metric_transformation {
    name = "${var.withdraw_end_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.withdraw_end_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_withdraw_end" {
  alarm_name = "${var.withdraw_end_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_withdraw_end.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_withdraw_end" {
  log_group_name = "${aws_cloudwatch_log_group.withdraw_end.name}"
  metric_transformation {
    name = "${var.withdraw_end_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.withdraw_end_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_withdraw_end" {
  alarm_name = "${var.withdraw_end_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_withdraw_end.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}