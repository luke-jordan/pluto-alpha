variable "verify_jwt_lambda_function_name" {
  default = "verify_jwt"
  type = "string"
}

resource "aws_lambda_function" "verify_jwt" {

  function_name                  = "${var.verify_jwt_lambda_function_name}"
  role                           = "${aws_iam_role.verify_jwt_role.arn}"
  handler                        = "index.verifyJsonWebToken"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "auth_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "tables": {
                  "accountTransactions": "transaction_data.core_transaction_ledger",
                  "rewardTransactions": "transaction_data.core_transaction_ledger",
                  "floatTransactions": "float_data.float_transaction_ledger"
              },
              "db": {
                  "user": "save_tx_api_worker",
                  "host": "localhost",
                  "database": "pluto",
                  "password": "pwd_for_transaction_api",
                  "port" :"5430"
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.verify_jwt]
}

resource "aws_iam_role" "verify_jwt_role" {
  name = "${var.verify_jwt_lambda_function_name}_role"

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

resource "aws_cloudwatch_log_group" "verify_jwt" {
  name = "/aws/lambda/${var.verify_jwt_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}


resource "aws_iam_role_policy_attachment" "verify_jwt_basic_execution_policy" {
  role = "${aws_iam_role.verify_jwt_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "verify_jwt_vpc_execution_policy" {
  role = "${aws_iam_role.verify_jwt_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_verify_jwt" {
  log_group_name = "${aws_cloudwatch_log_group.verify_jwt.name}"
  metric_transformation {
    name = "${var.verify_jwt_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.verify_jwt_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_verify_jwt" {
  alarm_name = "${var.verify_jwt_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_verify_jwt.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_verify_jwt" {
  log_group_name = "${aws_cloudwatch_log_group.verify_jwt.name}"
  metric_transformation {
    name = "${var.verify_jwt_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.verify_jwt_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_verify_jwt" {
  alarm_name = "${var.verify_jwt_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_verify_jwt.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.security_errors_topic.arn}"]
}