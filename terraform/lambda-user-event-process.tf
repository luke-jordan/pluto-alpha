variable "user_event_process" {
  default = "user_event_process"
  type = "string"
}

resource "aws_lambda_function" "user_event_process" {

  function_name                  = "${var.user_event_process}"
  role                           = "${aws_iam_role.user_event_process_role.arn}"
  handler                        = "event-handler.handleUserEvent"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
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
                "host": "${aws_db_instance.rds[0].address}",
                "database": "${var.db_name}",
                "port" :"${aws_db_instance.rds[0].port}"
              },
              "cache": {
                "host": "${aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.address}",
                "port": "${aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.port}"
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "message_api_worker": "${terraform.workspace}/ops/psql/message"
                }
              },
              "publishing": {
                "userEvents": {
                  "topicArn": "${var.user_event_topic_arn[terraform.workspace]}",
                  "processingDlq": "${aws_sqs_queue.user_event_dlq.name}"
                },
                "processingLambdas": {
                  "boosts": "${aws_lambda_function.boost_event_process.function_name}"
                }
              },
              "templates": {
                "bucket": "${terraform.workspace}.jupiter.templates",
                "withdrawal": "emails/withdrawalEmail.html"
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

  depends_on = [aws_cloudwatch_log_group.user_event_process]
}

resource "aws_iam_role" "user_event_process_role" {
  name = "${var.user_event_process}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "user_event_process" {
  name = "/aws/lambda/${var.user_event_process}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "user_event_process_basic_execution_policy" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_event_process_vpc_execution_policy" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_event_process_secret_get" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_message_worker_read"
}

resource "aws_iam_role_policy_attachment" "user_event_process_achievements" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_user_event_processing.arn}"
}

////////////////// SUBSCRIPTION TO TOPIC //////////////////////////////////////////////////////////////

resource "aws_sns_topic_subscription" "user_event_process_lambda" {
  topic_arn = "${var.user_event_topic_arn[terraform.workspace]}"
  protocol = "lambda"
  endpoint = "${aws_lambda_function.user_event_process.arn}"
}

resource "aws_lambda_permission" "with_sns" {
    statement_id = "EventProcessAllowExecutionFromSNS"
    action = "lambda:InvokeFunction"
    function_name = "${aws_lambda_function.user_event_process.function_name}"
    principal = "sns.amazonaws.com"
    source_arn = "${var.user_event_topic_arn[terraform.workspace]}"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_user_event_process" {
  log_group_name = "${aws_cloudwatch_log_group.user_event_process.name}"
  metric_transformation {
    name = "${var.user_event_process}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.user_event_process}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_user_event_process" {
  alarm_name = "${var.user_event_process}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_user_event_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_user_event_process" {
  log_group_name = "${aws_cloudwatch_log_group.user_event_process.name}"
  metric_transformation {
    name = "${var.user_event_process}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.user_event_process}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_user_event_process" {
  alarm_name = "${var.user_event_process}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_user_event_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}