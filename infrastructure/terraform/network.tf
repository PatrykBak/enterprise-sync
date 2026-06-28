# VPC
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${var.project_name}-vpc"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "${var.project_name}-igw"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Public Subnets
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.project_name}-public-a"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.project_name}-public-b"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Private Subnets (for stateful services)
resource "aws_subnet" "private_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.10.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = false

  tags = {
    Name        = "${var.project_name}-private-a"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_subnet" "private_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.11.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = false

  tags = {
    Name        = "${var.project_name}-private-b"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Elastic IP for NAT Gateway
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name        = "${var.project_name}-nat-eip"
    Environment = var.environment
    Project     = var.project_name
  }
}

# NAT Gateway (in public subnet)
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id

  tags = {
    Name        = "${var.project_name}-nat"
    Environment = var.environment
    Project     = var.project_name
  }

  depends_on = [aws_internet_gateway.main]
}

# Public Route Table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "${var.project_name}-public-rt"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Public Route Table Association
resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# Private Route Table
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name        = "${var.project_name}-private-rt"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Private Route Table Association
resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# Security Group: Allow internal VPC traffic
resource "aws_security_group" "internal" {
  name        = "${var.project_name}-internal-sg"
  description = "Allow internal VPC traffic"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
    description = "Allow all internal traffic within the SG"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name        = "${var.project_name}-internal-sg"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Security Group: PostgreSQL access (from internal SG only)
resource "aws_security_group" "postgres" {
  name        = "${var.project_name}-postgres-sg"
  description = "Allow PostgreSQL access from internal VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.internal.id]
    description     = "PostgreSQL access from internal SG"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name        = "${var.project_name}-postgres-sg"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Security Group: Redis access (from internal VPC only)
resource "aws_security_group" "redis" {
  name        = "${var.project_name}-redis-sg"
  description = "Allow Redis access from internal VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.internal.id]
    description     = "Redis access from internal SG"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name        = "${var.project_name}-redis-sg"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Security Group: RabbitMQ access (from internal VPC only)
resource "aws_security_group" "rabbitmq" {
  name        = "${var.project_name}-rabbitmq-sg"
  description = "Allow RabbitMQ access from internal VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5671
    to_port         = 5672
    protocol        = "tcp"
    security_groups = [aws_security_group.internal.id]
    description     = "RabbitMQ AMQP access from internal SG"
  }

  ingress {
    from_port       = 15671
    to_port         = 15672
    protocol        = "tcp"
    security_groups = [aws_security_group.internal.id]
    description     = "RabbitMQ Management Console from internal SG"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name        = "${var.project_name}-rabbitmq-sg"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Outputs
output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

output "internal_security_group_id" {
  description = "Internal Security Group ID"
  value       = aws_security_group.internal.id
}

output "postgres_security_group_id" {
  description = "PostgreSQL Security Group ID"
  value       = aws_security_group.postgres.id
}

output "redis_security_group_id" {
  description = "Redis Security Group ID"
  value       = aws_security_group.redis.id
}

output "rabbitmq_security_group_id" {
  description = "RabbitMQ Security Group ID"
  value       = aws_security_group.rabbitmq.id
}
