variable "user_insertion_handler_lambda_function_name" {
  default = "user-insertion-handler"
  type = "string"
}

resource "aws_lambda_function" "user-insertion-handler" {

  function_name                  = "${var.user_insertion_handler_lambda_function_name}"
  role                           = "${aws_iam_role.user-insertion-handler-role.arn}"
  handler                        = "user-insertion-handler.insertUserCredentials"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.user_insertion_handler_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

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

  depends_on = [aws_cloudwatch_log_group.user-insertion-handler, aws_cloudwatch_log_group.user-insertion-handler]
}

resource "aws_iam_role" "user-insertion-handler-role" {
  name = "${var.user_insertion_handler_lambda_function_name}-role"

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

resource "aws_cloudwatch_log_group" "user-insertion-handler" {
  name = "/aws/lambda/${var.user_insertion_handler_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}


resource "aws_iam_role_policy_attachment" "user_insertion_handler_basic_execution_policy" {
  role = "${aws_iam_role.user-insertion-handler-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_insertion_handler_vpc_execution_policy" {
  role = "${aws_iam_role.user-insertion-handler-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

module "user-insertion-handler-alarm-fatal-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.user_insertion_handler_lambda_function_name}-fatal-api-alarm"
  log_group_name = "/aws/lambda/${var.user_insertion_handler_lambda_function_name}"
  pattern = "FATAL_ERROR"
  alarm_action_arn = "${aws_sns_topic.fatal_errors_topic.arn}"
  statistic = "Sum"
}

module "user-insertion-handler-alarm-security-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.user_insertion_handler_lambda_function_name}-security-api-alarm"
  log_group_name = "/aws/lambda/${var.user_insertion_handler_lambda_function_name}"
  pattern = "SECURITY_ERROR"
  alarm_action_arn = "${aws_sns_topic.security_errors_topic.arn}"
  statistic = "Sum"
}
