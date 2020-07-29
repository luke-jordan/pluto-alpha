variable "boost_user_process_lambda_function_name" {
  default = "boost_user_process"
  type = "string"
}

resource "aws_lambda_function" "boost_user_process" {

  function_name                  = "${var.boost_user_process_lambda_function_name}"
  role                           = "${aws_iam_role.boost_user_process_role.arn}"
  handler                        = "boost-user-handler.processUserBoostResponse"
  memory_size                    = 512
  runtime                        = "nodejs12.x"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "boost_api/${var.deploy_code_commit_hash}.zip"

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
                "port": local.database_config.port
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "boost_worker": "${terraform.workspace}/ops/psql/boost"
                }
              },
              "publishing": {
                "userEvents": {
                    "topicArn": var.user_event_topic_arn[terraform.workspace]
                },
                "hash": {
                  "key": var.log_hashing_secret[terraform.workspace]
                }
              },
              "lambdas": {
                "boostsExpire": aws_lambda_function.boost_expire.function_name
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.boost_user_process]
}

resource "aws_iam_role" "boost_user_process_role" {
  name = "${var.boost_user_process_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "boost_user_process" {
  name = "/aws/lambda/${var.boost_user_process_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "boost_user_process_basic_execution_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_vpc_execution_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_invoke_transfer_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_float_transfer_access.arn}"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_invoke_message_create_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_message_create_access.arn}"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_invoke_boost_expiry_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_boost_expiry_access.arn}"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_user_event_publish_policy" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "${aws_iam_policy.ops_sns_user_event_publish.arn}"
}

resource "aws_iam_role_policy_attachment" "boost_user_process_secret_get" {
  role = "${aws_iam_role.boost_user_process_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_boost_worker_read"
}



////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_boost_user_process" {
  log_group_name = "${aws_cloudwatch_log_group.boost_user_process.name}"
  metric_transformation {
    name = "${var.boost_user_process_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.boost_user_process_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_boost_user_process" {
  alarm_name = "${var.boost_user_process_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_boost_user_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_boost_user_process" {
  log_group_name = "${aws_cloudwatch_log_group.boost_user_process.name}"
  metric_transformation {
    name = "${var.boost_user_process_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.boost_user_process_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_boost_user_process" {
  alarm_name = "${var.boost_user_process_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_boost_user_process.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}