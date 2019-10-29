variable "ops_admin_scheduled_lambda_function_name" {
  default = "ops_admin_scheduled"
  type = "string"
}

resource "aws_lambda_function" "ops_admin_scheduled" {

  function_name                  = "${var.ops_admin_scheduled_lambda_function_name}"
  role                           = "${aws_iam_role.ops_admin_scheduled_role.arn}"
  handler                        = "scheduled-job.runRegularJobs"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 90
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
                  "region": "${var.aws_default_region[terraform.workspace]}",
                  "endpoints": {
                    "lambda": null
                  }
              },
              "db": {
                "host": "${aws_db_instance.rds[0].address}",
                "database": "${var.db_name}",
                "port" :"${aws_db_instance.rds[0].port}"
              },
              "secrets": {
                  "enabled": true,
                  "names": {
                      "admin_api_worker": "${terraform.workspace}/ops/psql/admin"
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

  depends_on = [aws_cloudwatch_log_group.ops_admin_scheduled]
}

resource "aws_iam_role" "ops_admin_scheduled_role" {
  name = "${var.ops_admin_scheduled_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "ops_admin_scheduled" {
  name = "/aws/lambda/${var.ops_admin_scheduled_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "ops_admin_scheduled_basic_execution_policy" {
  role = "${aws_iam_role.ops_admin_scheduled_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "ops_admin_scheduled_vpc_execution_policy" {
  role = "${aws_iam_role.ops_admin_scheduled_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_scheduled_job_secret_get" {
  role = "${aws_iam_role.ops_admin_scheduled_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/secrets_read_admin_worker"
}

resource "aws_iam_role_policy_attachment" "admin_scheduled_job_float_access" {
  role = "${aws_iam_role.ops_admin_scheduled_role.name}"
  policy_arn = "${aws_iam_policy.admin_client_float_access.arn}"
}

resource "aws_iam_role_policy_attachment" "admin_scheduled_job_permissions" {
  role = "${aws_iam_role.ops_admin_scheduled_role.name}"
  policy_arn = "${aws_iam_policy.daily_job_lambda_policy.arn}"
}

/////////////////// CLOUD WATCH FOR EVENT SOURCE ///////////////////////

resource "aws_cloudwatch_event_target" "trigger_ops_admin_scheduled_every_day" {
    rule = "${aws_cloudwatch_event_rule.ops_every_day.name}"
    target_id = "${aws_lambda_function.ops_admin_scheduled.id}"
    arn = "${aws_lambda_function.ops_admin_scheduled.arn}"
}

resource "aws_lambda_permission" "allow_cloudwatch_to_call_ops_admin_scheduled" {
    statement_id = "AllowDailyAdminExecutionFromCloudWatch"
    action = "lambda:InvokeFunction"
    function_name = "${aws_lambda_function.ops_admin_scheduled.function_name}"
    principal = "events.amazonaws.com"
    source_arn = "${aws_cloudwatch_event_rule.ops_every_day.arn}"
}
