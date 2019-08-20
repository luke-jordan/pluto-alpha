variable "boost_create_lambda_function_name" {
  default = "boost_create"
  type = "string"
}

resource "aws_lambda_function" "boost_create" {

  function_name                  = "${var.boost_create_lambda_function_name}"
  role                           = "${aws_iam_role.boost_create_role.arn}"
  handler                        = "boost-handler.createBoost"
  memory_size                    = 512
  runtime                        = "nodejs8.10"
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
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "db": {
                "host": "${aws_db_instance.rds[0].address}",
                "database": "${var.db_name}",
                "port" :"${aws_db_instance.rds[0].port}"
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "boost_worker": "${terraform.workspace}/ops/psql/boost"
                }
              },
              "publishing": {
                "userEvents": {
                    "topicArn": "${var.user_event_topic_arn[terraform.workspace]}"
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

  depends_on = [aws_cloudwatch_log_group.boost_create]
}

resource "aws_iam_role" "boost_create_role" {
  name = "${var.boost_create_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "boost_create" {
  name = "/aws/lambda/${var.boost_create_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "boost_create_basic_execution_policy" {
  role = "${aws_iam_role.boost_create_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_create_vpc_execution_policy" {
  role = "${aws_iam_role.boost_create_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_create_user_event_publish_policy" {
  role = "${aws_iam_role.boost_create_role.name}"
  policy_arn = "${aws_iam_policy.ops_sns_user_event_publish.arn}"
}

resource "aws_iam_role_policy_attachment" "boost_create_secret_get" {
  role = "${aws_iam_role.boost_create_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_boost_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_boost_create" {
  log_group_name = "${aws_cloudwatch_log_group.boost_create.name}"
  metric_transformation {
    name = "${var.boost_create_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.boost_create_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_boost_create" {
  alarm_name = "${var.boost_create_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_boost_create.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_boost_create" {
  log_group_name = "${aws_cloudwatch_log_group.boost_create.name}"
  metric_transformation {
    name = "${var.boost_create_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.boost_create_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_boost_create" {
  alarm_name = "${var.boost_create_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_boost_create.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}