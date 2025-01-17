variable "payment_url_request_lambda_function_name" {
  default = "payment_url_request"
  type = "string"
}

resource "aws_lambda_function" "payment_url_request" {

  function_name                  = "${var.payment_url_request_lambda_function_name}"
  role                           = "${aws_iam_role.payment_url_request_role.arn}"
  handler                        = "payment-handler.paymentUrlRequest"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
  timeout                        = 15
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "third_parties/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "ozow": {
                "apiKey": "${var.ozow_apikey[terraform.workspace]}",
                "siteCode": "${var.ozow_sitecode[terraform.workspace]}",
                "privateKey": "${var.ozow_privatekey[terraform.workspace]}",
                "endpoints": {
                  "completionBase": "https://${aws_api_gateway_domain_name.custom_doname_name.domain_name}/addcash/result"
                }
              }
          }
      )}"
    }
  }
  
  # may not need as does not access db
  # vpc_config {
  #   subnet_ids = [for subnet in aws_subnet.private : subnet.id]
  #   security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  # }

  depends_on = [aws_cloudwatch_log_group.payment_url_request]
}

resource "aws_iam_role" "payment_url_request_role" {
  name = "${var.payment_url_request_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "payment_url_request" {
  name = "/aws/lambda/${var.payment_url_request_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "payment_url_request_basic_execution_policy" {
  role = "${aws_iam_role.payment_url_request_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# resource "aws_iam_role_policy_attachment" "payment_url_request_vpc_execution_policy" {
#   role = "${aws_iam_role.payment_url_request_role.name}"
#   policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
# }

////////////////// CLOUD WATCH ///////////////////////////////////////////////////////////////////////

resource "aws_cloudwatch_log_metric_filter" "fatal_metric_filter_payment_url_request" {
  log_group_name = "${aws_cloudwatch_log_group.payment_url_request.name}"
  metric_transformation {
    name = "${var.payment_url_request_lambda_function_name}_fatal_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.payment_url_request_lambda_function_name}_fatal_api_alarm"
  pattern = "FATAL_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "fatal_metric_alarm_payment_url_request" {
  alarm_name = "${var.payment_url_request_lambda_function_name}_fatal_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.fatal_metric_filter_payment_url_request.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = ["${aws_sns_topic.fatal_errors_topic.arn}"]
}

resource "aws_cloudwatch_log_metric_filter" "security_metric_filter_payment_url_request" {
  log_group_name = "${aws_cloudwatch_log_group.payment_url_request.name}"
  metric_transformation {
    name = "${var.payment_url_request_lambda_function_name}_security_api_alarm"
    namespace = "lambda_errors"
    value = "1"
  }
  name = "${var.payment_url_request_lambda_function_name}_security_api_alarm"
  pattern = "SECURITY_ERROR"
}

resource "aws_cloudwatch_metric_alarm" "security_metric_alarm_payment_url_request" {
  alarm_name = "${var.payment_url_request_lambda_function_name}_security_api_alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods = 1
  metric_name = "${aws_cloudwatch_log_metric_filter.security_metric_filter_payment_url_request.name}"
  namespace = "lambda_errors"
  period = 60
  threshold = 0
  statistic = "Sum"
  alarm_actions = [aws_sns_topic.security_errors_topic.arn]
}
