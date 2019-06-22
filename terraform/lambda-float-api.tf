resource "aws_api_gateway_rest_api" "float-api" {
  name        = "float-api"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = "${aws_api_gateway_rest_api.float-api.id}"
  parent_id   = "${aws_api_gateway_rest_api.float-api.root_resource_id}"
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = "${aws_api_gateway_rest_api.float-api.id}"
  resource_id   = "${aws_api_gateway_resource.proxy.id}"
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "lambda" {
  rest_api_id = "${aws_api_gateway_rest_api.float-api.id}"
  resource_id = "${aws_api_gateway_method.proxy.resource_id}"
  http_method = "${aws_api_gateway_method.proxy.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.float-api.invoke_arn}"

  depends_on = [aws_lambda_function.float-api]
}

resource "aws_api_gateway_deployment" "test" {
  depends_on  = ["aws_api_gateway_integration.lambda"]
  rest_api_id = "${aws_api_gateway_rest_api.float-api.id}"
  stage_name  = "float"
}

resource "aws_lambda_permission" "allow_lambda_invocation" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.float-api.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_deployment.test.execution_arn}/*/*"
}

resource "aws_lambda_function" "float-api" {

  function_name                  = "float-api"
  role                           = "${aws_iam_role.float-api-role.arn}"
  handler                        = "main.handler"
  memory_size                    = 256
  reserved_concurrent_executions = 20
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  

  environment {
    variables = {
      config = "${var.lambda-pluto-api-env}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.float-api.id]
  }

  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "latest.zip"

  depends_on = [aws_iam_role.float-api-role]
}

resource "aws_security_group" "float-api" {
  name = "${terraform.workspace}-float-api"

  vpc_id = "${aws_vpc.main.id}"

  // allows traffic from the SG itself
  ingress {
      from_port = 0
      to_port = 0
      protocol = "-1"
      self = true
  }

  //allow traffic for TCP 5432
  ingress {
      from_port = 8080
      to_port   = 8080
      protocol  = "tcp"
  }
}

resource "aws_iam_role" "float-api-role" {
  name = "iam_for_lambda"

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
  role = "${aws_iam_role.float-api-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "aws_lambda_vpc" {
  role = "${aws_iam_role.float-api-role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}


