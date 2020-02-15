variable "message_push" {
  default = "message_push"
  type = "string"
}

resource "aws_lambda_function" "message_push" {

  function_name                  = "${var.message_push}"
  role                           = "${aws_iam_role.message_push_role.arn}"
  handler                        = "message-push-handler.sendOutboundMessages"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 60
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "user_messaging_api/${var.deploy_code_commit_hash}.zip"

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
                    "message_api_worker": "${terraform.workspace}/ops/psql/message"
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
              "email": {
                "fromAddress": "${var.messaging_source_email_address[terraform.workspace]}",
                "wrapper": {
                  "bucket": "${terraform.workspace}.jupiter.templates"
                }
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.message_push]
}

resource "aws_iam_role" "message_push_role" {
  name = "${var.message_push}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "message_push" {
  name = "/aws/lambda/${var.message_push}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "message_push_basic_execution_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "message_push_vpc_execution_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "message_user_push_profile_table_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = var.user_profile_table_read_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "message_push_user_event_publish_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}

resource "aws_iam_role_policy_attachment" "message_push_other_invocation_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = aws_iam_policy.message_push_lambda_policy.arn
}

resource "aws_iam_role_policy_attachment" "message_push_fetch_profile_invoke_policy" {
  role = aws_iam_role.message_push_role.name
  policy_arn = var.user_profile_admin_policy_arn[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "message_push_secret_get" {
  role = "${aws_iam_role.message_push_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_message_worker_read"
}

////////////////// TRIGGER FOR THE PUSH //////////////////////////////////////////////////////////////

resource "aws_cloudwatch_event_target" "trigger_msg_picker_every_minute" {
    rule = "${aws_cloudwatch_event_rule.ops_every_minute.name}"
    target_id = "${aws_lambda_function.message_push.id}"
    arn = "${aws_lambda_function.message_push.arn}"
}

resource "aws_lambda_permission" "allow_cloudwatch_to_call_message_pusher" {
    statement_id = "AllowMsgPushExecutionFromCloudWatch"
    action = "lambda:InvokeFunction"
    function_name = "${aws_lambda_function.message_push.function_name}"
    principal = "events.amazonaws.com"
    source_arn = "${aws_cloudwatch_event_rule.ops_every_minute.arn}"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_message_push" {
  log_group_name = "${aws_cloudwatch_log_group.message_push.name}"
  metric_transformation {
    name = "${var.message_push}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.message_push}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_message_push" {
  alarm_name = "${var.message_push}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_message_push.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_message_push" {
  log_group_name = "${aws_cloudwatch_log_group.message_push.name}"
  metric_transformation {
    name = "${var.message_push}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.message_push}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_message_push" {
  alarm_name = "${var.message_push}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_message_push.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}