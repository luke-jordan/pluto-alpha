variable "user_history_list" {
  default = "user_history_list"
  type = "string"
}

resource "aws_lambda_function" "user_history_list" {

  function_name                  = "${var.user_history_list}"
  role                           = "${aws_iam_role.user_history_list_role.arn}"
  handler                        = "history-handler.fetchUserHistory"
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
              "secrets": {
                "enabled": true,
                "names": {
                    "save_tx_api_worker": "${terraform.workspace}/ops/psql/transactions"
                }
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, 
      aws_security_group.sg_cache_6379_ingress.id, aws_security_group.sg_ops_cache_access.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.user_history_list]
}

resource "aws_iam_role" "user_history_list_role" {
  name = "${var.user_history_list}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "user_history_list" {
  name = "/aws/lambda/${var.user_history_list}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "user_history_list_basic_execution_policy" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_history_list_vpc_execution_policy" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_history_list_secret_get" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_transaction_worker_read"
}

resource "aws_iam_role_policy_attachment" "user_history_log_invoke_policy" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = "${var.user_profile_history_invoke_policy_arn[terraform.workspace]}"
}

resource "aws_iam_role_policy_attachment" "user_history_balance_invoke_policy" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = aws_iam_policy.balance_lambda_invoke_policy.arn
}

resource "aws_iam_role_policy_attachment" "user_history_client_float_table_access" {
  role = aws_iam_role.user_history_list_role.name
  policy_arn = aws_iam_policy.dynamo_table_client_float_table_access.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_user_history_list" {
  log_group_name = "${aws_cloudwatch_log_group.user_history_list.name}"
  metric_transformation {
    name = "${var.user_history_list}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.user_history_list}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_user_history_list" {
  alarm_name = "${var.user_history_list}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_user_history_list.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_user_history_list" {
  log_group_name = "${aws_cloudwatch_log_group.user_history_list.name}"
  metric_transformation {
    name = "${var.user_history_list}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.user_history_list}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_user_history_list" {
  alarm_name = "${var.user_history_list}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_user_history_list.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}