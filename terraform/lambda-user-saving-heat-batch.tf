variable "user_save_heat_batch" {
  default = "user_save_heat_batch"
  type = string
}

resource "aws_lambda_function" "user_save_heat_batch" {

  function_name                  = var.user_save_heat_batch
  role                           = aws_iam_role.user_save_heat_batch_role.arn
  handler                        = "heat-handler.calculateHeatStateForAllUsers"
  memory_size                    = 512
  runtime                        = "nodejs12.x"
  timeout                        = 60
  tags                           = {"environment"  = terraform.workspace}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "user_activity_api/${var.deploy_code_commit_hash}.zip"

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
              "cache": {
                "host": aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.address,
                "port": aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.port
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "save_tx_api_worker": "${terraform.workspace}/ops/psql/transactions"
                }
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
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, 
      aws_security_group.sg_cache_6379_ingress.id, aws_security_group.sg_ops_cache_access.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.user_save_heat_batch]
}

resource "aws_iam_role" "user_save_heat_batch_role" {
  name = "${var.user_save_heat_batch}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "user_save_heat_batch" {
  name = "/aws/lambda/${var.user_save_heat_batch}"
  retention_in_days = 3

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy_attachment" "user_save_heat_batch_basic_execution_policy" {
  role = aws_iam_role.user_save_heat_batch_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_save_heat_batch_vpc_execution_policy" {
  role = aws_iam_role.user_save_heat_batch_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_save_heat_batch_profile_fetch" {
  role = aws_iam_role.user_save_heat_batch_role.name
  policy_arn = var.user_profile_admin_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "user_save_heat_batch_secret_get" {
  role = aws_iam_role.user_save_heat_batch_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_transaction_worker_read"
}

resource "aws_iam_role_policy_attachment" "user_save_heat_batch_event_publish_policy" {
  role = aws_iam_role.user_save_heat_batch_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}


/////////////////// CLOUD WATCH FOR EVENT SOURCE, DAILY (DROP TO MONTHLY ONCE STABLE) ////////////////////

resource "aws_cloudwatch_event_target" "trigger_ops_heat_batch_update" {
    rule = aws_cloudwatch_event_rule.ops_every_day.name
    target_id = aws_lambda_function.user_save_heat_batch.id
    arn = aws_lambda_function.user_save_heat_batch.arn

    input = jsonencode({}) // for now, may add client/float params in future
}

resource "aws_lambda_permission" "allow_cloudwatch_to_call_heat_batch_update" {
    statement_id = "AllowDailyAdminExecutionFromCloudWatch"
    action = "lambda:InvokeFunction"
    function_name = aws_lambda_function.user_save_heat_batch.function_name
    principal = "events.amazonaws.com"
    source_arn = aws_cloudwatch_event_rule.ops_every_day.arn
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_user_save_heat_batch" {
  log_group_name = aws_cloudwatch_log_group.user_save_heat_batch.name
  metric_transformation {
    name = "${var.user_save_heat_batch}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.user_save_heat_batch}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_user_save_heat_batch" {
  alarm_name = "${var.user_save_heat_batch}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = aws_cloudwatch_log_metric_filter.fatal_metric_filter_user_save_heat_batch.name
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.fatal_errors_topic.arn]
}
