variable "friend_pool_read" {
  default = "friend_pool_read"
  type = "string"
}

resource "aws_lambda_function" "friend_pool_read" {

  function_name                  = "${var.friend_pool_read}"
  role                           = "${aws_iam_role.friend_pool_read_role.arn}"
  handler                        = "friend-saving-handler.readSavingPool"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 15
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "friend_api/${var.deploy_code_commit_hash}.zip"

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
                    "friend_api_worker": "${terraform.workspace}/ops/psql/friend"
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

  depends_on = [aws_cloudwatch_log_group.friend_pool_read]
}

resource "aws_iam_role" "friend_pool_read_role" {
  name = "${var.friend_pool_read}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "friend_pool_read" {
  name = "/aws/lambda/${var.friend_pool_read}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "friend_pool_read_basic_execution_policy" {
  role = aws_iam_role.friend_pool_read_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "friend_pool_read_vpc_execution_policy" {
  role = aws_iam_role.friend_pool_read_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "friend_pool_read_secret_get" {
  role = aws_iam_role.friend_pool_read_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_friend_worker_read"
}

resource "aws_iam_role_policy_attachment" "friend_pool_read_profile_invoke_policy" {
  role = aws_iam_role.friend_pool_read_role.name
  policy_arn = var.user_profile_table_read_policy_arn[terraform.workspace]
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_friend_pool_read" {
  log_group_name = "${aws_cloudwatch_log_group.friend_pool_read.name}"
  metric_transformation {
    name = "${var.friend_pool_read}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.friend_pool_read}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_friend_pool_read" {
  alarm_name = "${var.friend_pool_read}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_friend_pool_read.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_friend_pool_read" {
  log_group_name = "${aws_cloudwatch_log_group.friend_pool_read.name}"
  metric_transformation {
    name = "${var.friend_pool_read}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.friend_pool_read}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_friend_pool_read" {
  alarm_name = "${var.friend_pool_read}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_friend_pool_read.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}