variable "user_act_api_lambda_function_name" {
  default = "user-act-api"
  type = "string"
}

resource "aws_lambda_function" "user-act-api" {

  function_name                  = "${var.user_act_api_lambda_function_name}"
  role                           = "${aws_iam_role.user-act-api-role.arn}"
  handler                        = "index.handler"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.user_act_api_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
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

  depends_on = [aws_cloudwatch_log_group.user-act-api]
}

resource "aws_iam_role" "user-act-api-role" {
  name = "${var.user_act_api_lambda_function_name}-role"

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

resource "aws_cloudwatch_log_group" "user-act-api" {
  name = "/aws/lambda/${var.user_act_api_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}


resource "aws_iam_role_policy_attachment" "user_act_api_basic_execution_policy" {
  role = "${aws_iam_role.user-act-api-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "user_act_api_vpc_execution_policy" {
  role = "${aws_iam_role.user-act-api-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

module "user-act-api-alarm-fatal-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.user_act_api_lambda_function_name}-fatal-api-alarm"
  log_group_name = "/aws/lambda/${var.user_act_api_lambda_function_name}"
  pattern = "FATAL_ERROR"
  alarm_action_arn = "${aws_sns_topic.fatal_errors_topic.arn}"
  statistic = "Sum"
}

module "user-act-api-alarm-security-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.user_act_api_lambda_function_name}-security-api-alarm"
  log_group_name = "/aws/lambda/${var.user_act_api_lambda_function_name}"
  pattern = "SECURITY_ERROR"
  alarm_action_arn = "${aws_sns_topic.security_errors_topic.arn}"
  statistic = "Sum"
}
