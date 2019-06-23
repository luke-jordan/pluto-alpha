variable "lambda_function_name" {
  default = "float-api"
  type = "string"
}

module "lambda_with_api_gateway" {
  source = "./modules/lambda"
  lambda_function_name = "${var.lambda_function_name}"
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.lambda_function_name}/latest.zip"
  vpc_id = "${aws_vpc.main.id}"
  vpc_subnets = [for subnet in aws_subnet.private : subnet.id]

  in_port = 8080
  lambda_env = ""
  reserved_concurrent_executions = 900
  memory_size = 256
  timeout = 20
  handler = "main.handler"
  run_time = "nodejs8.10"

}

module "api-alarm-fatal-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.lambda_function_name}-fatal-api-alarm"
  log_group_name = "/aws/lambda/${var.lambda_function_name}"
  pattern = "FATAL_ERROR"
  alarm_action_arn = "${aws_sns_topic.fatal_errors_topic.arn}"
  statistic = "Sum"
}

module "api-alarm-security-errors" {
  source = "./modules/cloud_watch_alarm"
  
  metric_namespace = "lambda_errors"
  alarm_name = "${var.lambda_function_name}-security-api-alarm"
  log_group_name = "/aws/lambda/${var.lambda_function_name}"
  pattern = "SECURITY_ERROR"
  alarm_action_arn = "${aws_sns_topic.security_errors_topic.arn}"
  statistic = "Sum"
}

