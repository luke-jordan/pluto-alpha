variable "user_event_process" {
  default = "user_event_process"
  type = "string"
}

resource "aws_lambda_function" "user_event_process" {

  function_name                  = "${var.user_event_process}"
  role                           = "${aws_iam_role.user_event_process_role.arn}"
  handler                        = "event-handler.handleBatchOfQueuedEvents"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 180
  tags                           = {"environment"  = "${terraform.workspace}"}

  reserved_concurrent_executions = 5
  
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
              },
              "queues": {
                "boostProcess": aws_sqs_queue.boost_process_queue.name,
                "balanceSheetUpdate": aws_sqs_queue.balance_sheet_update_queue.name,
                "eventDlq": aws_sqs_queue.user_event_dlq.name
              },
              "publishing": {
                "withdrawalEmailDestination": var.events_email_receipients[terraform.workspace],
                "saveEmailDestination": var.events_email_receipients[terraform.workspace],
                "userEvents": {
                  "topicArn": "${var.user_event_topic_arn[terraform.workspace]}",
                  "processingDlq": "${aws_sqs_queue.user_event_dlq.name}"
                },
                "hash": {
                  "key": "${var.log_hashing_secret[terraform.workspace]}"
                },
                "eventsEmailAddress": "${var.events_source_email_address[terraform.workspace]}",
                "adminSiteUrl": "${terraform.workspace == "master" ? "https://admin.jupitersave.com" : "https://staging-admin.jupitersave.com"}",
                "accountsPhoneNumbers": var.events_phone_reciepients[terraform.workspace],
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

  dead_letter_config {
    target_arn = "${aws_sqs_queue.user_event_dlq.arn}"
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

resource "aws_iam_role_policy_attachment" "user_event_process_achievements" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_user_event_processing.arn}"
}

resource "aws_iam_role_policy_attachment" "user_event_fetch_profile_invoke_policy" {
  role = aws_iam_role.user_event_process_role.name
  policy_arn = var.user_profile_admin_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "user_event_process_secret_get" {
  role = "${aws_iam_role.user_event_process_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_transaction_worker_read"
}

resource "aws_iam_role_policy_attachment" "user_event_queue_polling_policy" {
  role = aws_iam_role.user_event_process_role.name
  policy_arn = aws_iam_policy.sqs_user_event_queue_poll.arn
}

////////////////// SUBSCRIPTION TO TOPIC (VIA QUEUE) ////////////////////////////////////////////////////////

resource "aws_lambda_event_source_mapping" "user_event_process_lambda" {
  event_source_arn = aws_sqs_queue.user_event_process_queue.arn
  enabled = true
  function_name = aws_lambda_function.user_event_process.arn
  batch_size = 5
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
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}