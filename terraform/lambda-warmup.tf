variable "ops_warmup_lambda_function_name" {
  default = "ops_warmup"
  type = "string"
}

resource "aws_lambda_function" "ops_warmup" {

  function_name                  = "${var.ops_warmup_lambda_function_name}"
  role                           = "${aws_iam_role.ops_warmup_role.arn}"
  handler                        = "index.handler"
  memory_size                    = 256
  runtime                        = "nodejs8.10"
  timeout                        = 900
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "${var.ops_warmup_lambda_function_name}/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                  "region": "${var.aws_default_region[terraform.workspace]}",
                  "endpoints": {
                    "lambda": null
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

  depends_on = [aws_cloudwatch_log_group.ops_warmup]
}

resource "aws_iam_role" "ops_warmup_role" {
  name = "${var.ops_warmup_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "ops_warmup" {
  name = "/aws/lambda/${var.ops_warmup_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "ops_warmup_basic_execution_policy" {
  role = "${aws_iam_role.ops_warmup_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "ops_warmup_vpc_execution_policy" {
  role = "${aws_iam_role.ops_warmup_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "warmup_lambda_invoke_policy" {
  role = "${aws_iam_role.ops_warmup_role.name}"
  policy_arn = "${aws_iam_policy.lambda_invoke_warmup_access.arn}"
}

