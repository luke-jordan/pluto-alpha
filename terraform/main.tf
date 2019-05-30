# Specify the provider and access details

# We use vault to get credentials, but you can use variables to achieve the same thing
variable "aws_access_key" {}
variable "aws_secret_key" {}

provider "aws" {
  access_key = "${var.aws_access_key}"
  secret_key = "${var.aws_secret_key}"
  region     = "${var.aws_region}"
}

### Network

# Fetch AZs in the current region
data "aws_availability_zones" "available" {}

resource "aws_vpc" "example" {
  cidr_block = "172.17.0.0/16"

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Create var.az_count private subnets, each in a different AZ
resource "aws_subnet" "private" {
  count             = "${var.az_count}"
  cidr_block        = "${cidrsubnet(aws_vpc.example.cidr_block, 8, count.index)}"
  availability_zone = "${data.aws_availability_zones.available.names[count.index]}"
  vpc_id            = "${aws_vpc.example.id}"

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Create var.az_count public subnets, each in a different AZ
resource "aws_subnet" "public" {
  count                   = "${var.az_count}"
  cidr_block              = "${cidrsubnet(aws_vpc.example.cidr_block, 8, var.az_count + count.index)}"
  availability_zone       = "${data.aws_availability_zones.available.names[count.index]}"
  vpc_id                  = "${aws_vpc.example.id}"
  map_public_ip_on_launch = true

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# IGW for the public subnet
resource "aws_internet_gateway" "gw" {
  vpc_id = "${aws_vpc.example.id}"

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Route the public subnet traffic through the IGW
resource "aws_route" "internet_access" {
  route_table_id         = "${aws_vpc.example.main_route_table_id}"
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = "${aws_internet_gateway.gw.id}"
}

# Create a NAT gateway with an EIP for each private subnet to get internet connectivity
resource "aws_eip" "gw" {
  count      = "${var.az_count}"
  vpc        = true
  depends_on = ["aws_internet_gateway.gw"]

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

resource "aws_nat_gateway" "gw" {
  count         = "${var.az_count}"
  subnet_id     = "${element(aws_subnet.public.*.id, count.index)}"
  allocation_id = "${element(aws_eip.gw.*.id, count.index)}"

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Create a new route table for the private subnets
# And make it route non-local traffic through the NAT gateway to the internet
resource "aws_route_table" "private" {
  count  = "${var.az_count}"
  vpc_id = "${aws_vpc.example.id}"

  route {
    cidr_block = "0.0.0.0/0"
    nat_gateway_id = "${element(aws_nat_gateway.gw.*.id, count.index)}"
  }

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Explicitely associate the newly created route tables to the private subnets (so they don't default to the main route table)
resource "aws_route_table_association" "private" {
  count          = "${var.az_count}"
  subnet_id      = "${element(aws_subnet.private.*.id, count.index)}"
  route_table_id = "${element(aws_route_table.private.*.id, count.index)}"
}

### Security

# ALB Security group
# This is the group you need to edit if you want to restrict access to your application
resource "aws_security_group" "lb" {
  name        = "tf-ecs-alb"
  description = "controls access to the ALB"
  vpc_id      = "${aws_vpc.example.id}"

  ingress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Traffic to the ECS Cluster should only come from the ALB
resource "aws_security_group" "ecs_tasks" {
  name        = "tf-ecs-tasks"
  description = "allow inbound access from the ALB only"
  vpc_id      = "${aws_vpc.example.id}"

  ingress {
    protocol        = "tcp"
    from_port       = "${var.app_port}"
    to_port         = "${var.app_port}"
    security_groups = ["${aws_security_group.lb.id}"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

### ALB

resource "aws_alb" "main" {
  name            = "${var.app_name}"
  subnets         = ["${aws_subnet.public.*.id}"]
  security_groups = ["${aws_security_group.lb.id}"]

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

resource "aws_alb_target_group" "app" {
  name        = "${var.app_name}"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = "${aws_vpc.example.id}"
  target_type = "ip"

  tags {
    Environment = "${var.app_name}-${var.environment}"
  }
}

# Redirect all traffic from the ALB to the target group
resource "aws_alb_listener" "front_end" {
  load_balancer_arn = "${aws_alb.main.id}"
  port              = "80"
  protocol          = "HTTP"

  default_action {
    target_group_arn = "${aws_alb_target_group.app.id}"
    type             = "forward"
  }
}

### ECS

resource "aws_ecs_cluster" "main" {
  name = "tf-ecs-cluster"

  depends_on = [
    "aws_ecr_repository.app"
  ]
}

resource "aws_ecs_task_definition" "app" {
  family                   = "app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "${var.fargate_cpu}"
  memory                   = "${var.fargate_memory}"
  execution_role_arn       = "${aws_iam_role.task_execution.arn}"

  depends_on = [
    "aws_db_instance.rds"
  ]


  container_definitions = <<DEFINITION
[
  {
    "cpu": ${var.fargate_cpu},
    "image": "${aws_ecr_repository.app.repository_url}:latest",
    "memory": ${var.fargate_memory},
    "name": "app",
    "networkMode": "awsvpc",
    "portMappings": [
      {
        "containerPort": ${var.app_port},
        "hostPort": ${var.app_port}
      }
    ],
    "environment": [
          {
            "name": "DATABASE_URL",
            "value": "${aws_db_instance.rds.address}"
          },
          {
            "name": "DATABASE_USER",
            "value": "${var.db_user}"
          },
          {
            "name": "PORT",
            "value": "${aws_db_instance.rds.port}"
          },
          {
            "name": "DATABASE_PASSWORD",
            "value": "${var.db_password}"
          },
          {
            "name": "DATABASE_NAME",
            "value": "${var.db_name}"
          }
        ]
      }
    ]
DEFINITION
}

resource "aws_ecs_service" "main" {
  name            = "tf-ecs-service"
  cluster         = "${aws_ecs_cluster.main.id}"
  task_definition = "${aws_ecs_task_definition.app.arn}"
  desired_count   = "${var.min_app_count}"
  launch_type     = "FARGATE"


  network_configuration {
    security_groups = ["${aws_security_group.ecs_tasks.id}", "${aws_security_group.db_access_sg.id}"]
    subnets         = ["${aws_subnet.private.*.id}"]
  }

  load_balancer {
    target_group_arn = "${aws_alb_target_group.app.id}"
    container_name   = "app"
    container_port   = "${var.app_port}"
  }


  depends_on = [
    "aws_alb_listener.front_end",
    "aws_security_group.db_access_sg"
  ]
}

resource "aws_appautoscaling_target" "app_scale_target" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.main.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  max_capacity       = "${var.max_app_count}"
  min_capacity       = "${var.min_app_count}"
}



resource "aws_cloudwatch_metric_alarm" "cpu_utilization_high" {
  alarm_name          = "${var.app_name}-${var.environment}-CPU-Utilization-High-${var.ecs_as_cpu_high_threshold_per}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "1"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = "60"
  statistic           = "Average"
  threshold           = "${var.ecs_as_cpu_high_threshold_per}"

  dimensions {
    ClusterName = "${aws_ecs_cluster.main.name}"
    ServiceName = "${aws_ecs_service.main.name}"
  }

  alarm_actions = ["${aws_appautoscaling_policy.app_up.arn}"]

}

resource "aws_cloudwatch_metric_alarm" "cpu_utilization_low" {
  alarm_name          = "${var.app_name}-${var.environment}-CPU-Utilization-Low-${var.ecs_as_cpu_low_threshold_per}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = "60"
  statistic           = "Average"
  threshold           = "${var.ecs_as_cpu_low_threshold_per}"

  dimensions {
    ClusterName = "${aws_ecs_cluster.main.name}"
    ServiceName = "${aws_ecs_service.main.name}"
  }

  alarm_actions = ["${aws_appautoscaling_policy.app_down.arn}"]
}

resource "aws_appautoscaling_policy" "app_up" {
  name               = "app-scale-up"
  service_namespace  = "${aws_appautoscaling_target.app_scale_target.service_namespace}"
  resource_id        = "${aws_appautoscaling_target.app_scale_target.resource_id}"
  scalable_dimension = "${aws_appautoscaling_target.app_scale_target.scalable_dimension}"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_appautoscaling_policy" "app_down" {
  name               = "app-scale-down"
  service_namespace  = "${aws_appautoscaling_target.app_scale_target.service_namespace}"
  resource_id        = "${aws_appautoscaling_target.app_scale_target.resource_id}"
  scalable_dimension = "${aws_appautoscaling_target.app_scale_target.scalable_dimension}"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}
