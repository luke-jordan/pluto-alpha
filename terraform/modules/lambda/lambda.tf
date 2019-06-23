variable "lambda_function_name" {
  type = "string"
}

variable "vpc_id" {
  type = "string"
}
variable "vpc_subnets" {
  type = "list"
}

variable "s3_bucket" {
  type = "string"
}
variable "s3_key" {
  type = "string"
}
variable "lambda_env" {
  type = "string"
}

variable "reserved_concurrent_executions" {
}
variable "memory_size" {
}
variable "timeout" {
}
variable "handler" {
  type = "string"
}
variable "run_time" {
  type = "string"
}
variable "lambda_security_groups" {
  type = "list"
}

resource "aws_api_gateway_rest_api" "api-gateway" {
  name        = "${var.lambda_function_name}-${terraform.workspace}-rest-api"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.api-gateway.root_resource_id}"
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id   = "${aws_api_gateway_resource.proxy.id}"
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "lambda" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  resource_id = "${aws_api_gateway_method.proxy.resource_id}"
  http_method = "${aws_api_gateway_method.proxy.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.the_lambda.invoke_arn}"
}

resource "aws_api_gateway_deployment" "api-deployment" {
  rest_api_id = "${aws_api_gateway_rest_api.api-gateway.id}"
  stage_name  = "${terraform.workspace}-stage"
}

resource "aws_lambda_permission" "allow_lambda_invocation" {
  action        = "lambda:InvokeFunction"
  function_name = "${var.lambda_function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.api-deployment.execution_arn}/*/*"
}

resource "aws_lambda_function" "the_lambda" {

  function_name                  = "${var.lambda_function_name}"
  role                           = "${aws_iam_role.lambda-basic-role.arn}"
  handler                        = "${var.handler}"
  memory_size                    = "${var.memory_size}"
  reserved_concurrent_executions = "${var.reserved_concurrent_executions}"
  runtime                        = "${var.run_time}"
  timeout                        = "${var.timeout}"
  tags                           = {"environment"  = "${terraform.workspace}"}
  

  environment {
    variables = {
      config = "${var.lambda_env}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in var.vpc_subnets : subnet]
    security_group_ids = var.lambda_security_groups
  }

  s3_bucket = "${var.s3_bucket}"
  s3_key = "${var.s3_key}"
}

resource "aws_iam_role" "lambda-basic-role" {
  name = "${var.lambda_function_name}-role"

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

resource "aws_iam_role_policy_attachment" "basic_execution_policy" {
  role = "${aws_iam_role.lambda-basic-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vpc_execution_policy" {
  role = "${aws_iam_role.lambda-basic-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}