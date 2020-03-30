variable "message_user_process_function_name" {
  default = "message_user_process"
  type = "string"
}

resource "aws_lambda_function" "message_user_process" {

  function_name                  = "${var.message_user_process_function_name}"
  role                           = "${aws_iam_role.message_user_process_role.arn}"
  handler                        = "message-picking-handler.updateUserMessage"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 900
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
                "region": "${var.aws_default_region[terraform.workspace]}",
                "endpoints": {
                    "dynamodb": null
                }
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
            }
        }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.message_user_process]
}

resource "aws_iam_role" "message_user_process_role" {
  name = "${var.message_user_process_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "message_user_process" {
  name = "/aws/lambda/${var.message_user_process_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "message_user_process_basic_execution_policy" {
  role = "${aws_iam_role.message_user_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "message_user_process_vpc_execution_policy" {
  role = "${aws_iam_role.message_user_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "message_user_process_transaction_secret_get" {
  role = "${aws_iam_role.message_user_process_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_message_worker_read"
}

////////////////// TRIGGER FOR PROCESSING //////////////////////////////////////////////////////////////

resource "aws_cloudwatch_event_target" "trigger_msg_process_five_minutes" {
    rule = aws_cloudwatch_event_rule.ops_every_five_minutes.name
    target_id = aws_lambda_function.message_user_process.id
    arn = aws_lambda_function.message_user_process.arn
}

resource "aws_lambda_permission" "allow_cloudwatch_to_call_message_process" {
    statement_id = "AllowMsgProcessExecutionFromCloudWatch"
    action = "lambda:InvokeFunction"
    function_name = "${aws_lambda_function.message_user_process.function_name}"
    principal = "events.amazonaws.com"
    source_arn = "${aws_cloudwatch_event_rule.ops_every_five_minutes.arn}"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_message_user_process" {
  log_group_name = "${aws_cloudwatch_log_group.message_user_process.name}"
  metric_transformation {
    name = "${var.message_user_process_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.message_user_process_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_message_user_process" {
  alarm_name = "${var.message_user_process_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_message_user_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_message_user_process" {
  log_group_name = "${aws_cloudwatch_log_group.message_user_process.name}"
  metric_transformation {
    name = "${var.message_user_process_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.message_user_process_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_message_user_process" {
  alarm_name = "${var.message_user_process_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_message_user_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}