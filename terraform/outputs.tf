output "alb_hostname" {
  value = "${aws_alb.main.dns_name}"
}

output "aws_iam_access_key_id" {
  value = "${aws_iam_access_key._web_app_deployer_access_key.id}"
}

output "aws_iam_secret_access_key" {
  value = "${aws_iam_access_key._web_app_deployer_access_key.secret}"
}

output "aws_ecr_repo_arn" {
  value = "${aws_ecr_repository.app.repository_url}"
}

output "aws_ecs_cluster_arn" {
  value = "${aws_ecs_cluster.main.arn}"
}

output "aws_ecs_service_name" {
  value = "${aws_ecs_service.main.name}"
}

output "aws_region" {
  value = "${var.aws_region}"
}