output "aws_default_region" {
  value = "${var.aws_default_region["${terraform.workspace}"]}"
}

output "workspace" {
  value = "${terraform.workspace}"
}

output "api_gw_url" {
  value = "${aws_api_gateway_deployment.api-deployment.invoke_url}"
}

