variable "db_migration_lambda_function_name" {
  default = "db_migration"
  type = "string"
}

resource "aws_lambda_function" "db_migration" {

  function_name                  = "${var.db_migration_lambda_function_name}"
  role                           = "${aws_iam_role.db_migration_role.arn}"
  handler                        = "handler.migrate"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 60
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.db_migration_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

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
                  "port" :"${local.database_config.port}"
                  "database": "${var.db_name}"
              },
              "s3": {
                "bucket": "jupiter.db.migration.scripts",
                "folder": "${terraform.workspace}/ops/"
              },
              "secrets": {
                  "enabled": true,
                  "names": {
                      "master": "${terraform.workspace}/ops/psql/main"
                  }
              },
              "scripts": {
                "location": "/tmp/scripts"
              }
          }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.db_migration]
}

resource "aws_iam_role" "db_migration_role" {
  name = "${var.db_migration_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "db_migration" {
  name = "/aws/lambda/${var.db_migration_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}



resource "aws_iam_role_policy_attachment" "migration_script_s3_access_policy" {
  role = "${aws_iam_role.db_migration_role.name}"
  policy_arn = "${aws_iam_policy.migration_script_s3_access.arn}"
}

resource "aws_iam_role_policy_attachment" "db_migration_basic_execution_policy" {
  role = "${aws_iam_role.db_migration_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "db_migration_vpc_execution_policy" {
  role = "${aws_iam_role.db_migration_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "db_migration_get_secret" {
  role = aws_iam_role.db_migration_role.name
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_main_worker_read"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_db_migration" {
  log_group_name = "${aws_cloudwatch_log_group.db_migration.name}"
  metric_transformation {
    name = "${var.db_migration_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.db_migration_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_db_migration" {
  alarm_name = "${var.db_migration_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_db_migration.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_db_migration" {
  log_group_name = "${aws_cloudwatch_log_group.db_migration.name}"
  metric_transformation {
    name = "${var.db_migration_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.db_migration_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_db_migration" {
  alarm_name = "${var.db_migration_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_db_migration.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}



