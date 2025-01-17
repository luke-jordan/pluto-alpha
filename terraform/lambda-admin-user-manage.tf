variable "admin_user_manage_lambda_function_name" {
  default = "admin_user_manage"
  type = string
}

resource "aws_lambda_function" "admin_user_manage" {

  function_name                  = "${var.admin_user_manage_lambda_function_name}"
  role                           = "${aws_iam_role.admin_user_manage_role.arn}"
  handler                        = "admin-user-manage.manageUser"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 30
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "admin_api/${var.deploy_code_commit_hash}.zip"

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
                "host": local.database_config.host,
                "database": local.database_config.database,
                "port": local.database_config.port
              },
              "lambdas": {
                "passwordUpdate": "password_update",
                "msgPrefsSet": aws_lambda_function.message_preferences.function_name
              }
              "secrets": {
                  "enabled": true,
                  "names": {
                      "admin_api_worker": "${terraform.workspace}/ops/psql/admin"
                  }
              },
              "publishing": {
                "userEvents": {
                    "topicArn": "${var.user_event_topic_arn[terraform.workspace]}"
                },
                "hash": {
                  "key": var.log_hashing_secret[terraform.workspace]
                }
              },
              "templates": {
                "bucket": "${terraform.workspace}.jupiter.templates"
              },
              "defaults": {
                "pword": {
                  "mock": {
                    "enabled": terraform.workspace == "staging",
                    "phone": "27813074085",
                    "email": "luke@jupitersave.com"
                  }
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

  depends_on = [aws_cloudwatch_log_group.admin_user_manage]
}

resource "aws_iam_role" "admin_user_manage_role" {
  name = "${var.admin_user_manage_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "admin_user_manage" {
  name = "/aws/lambda/${var.admin_user_manage_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_basic_execution_policy" {
  role = "${aws_iam_role.admin_user_manage_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_vpc_execution_policy" {
  role = "${aws_iam_role.admin_user_manage_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_profile_invoke_policy" {
  role = "${aws_iam_role.admin_user_manage_role.name}"
  policy_arn = "${var.user_profile_admin_policy_arn[terraform.workspace]}"
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_event_publish" {
  role = aws_iam_role.admin_user_manage_role.name
  policy_arn = aws_iam_policy.ops_sns_user_event_publish.arn
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_pword_update" {
  role = aws_iam_role.admin_user_manage_role.name
  policy_arn = var.pword_update_policy[terraform.workspace]
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_omnibus" {
  role = aws_iam_role.admin_user_manage_role.name
  policy_arn = aws_iam_policy.admin_user_manage_lambda_policy.arn
}

resource "aws_iam_role_policy_attachment" "admin_user_manage_secret_get" {
  role = "${aws_iam_role.admin_user_manage_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_admin_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_admin_user_manage" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_manage.name}"
  metric_transformation {
    name = "${var.admin_user_manage_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_manage_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_admin_user_manage" {
  alarm_name = "${var.admin_user_manage_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_admin_user_manage.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_admin_user_manage" {
  log_group_name = "${aws_cloudwatch_log_group.admin_user_manage.name}"
  metric_transformation {
    name = "${var.admin_user_manage_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.admin_user_manage_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_admin_user_manage" {
  alarm_name = "${var.admin_user_manage_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_admin_user_manage.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}
